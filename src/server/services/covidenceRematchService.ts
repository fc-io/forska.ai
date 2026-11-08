import {appendHumanJudgmentReviewServingDeltas} from '../reviewServing/humanJudgmentReviewServingDeltaService.ts'
import {appendProjectScopeArticleReviewServingDeltas} from '../reviewServing/projectScopeReviewServingDeltaService.ts'
import {HttpError} from '../utils/httpError.ts'
import {writeRuntimeOperatorLogEvent} from '../utils/runtimeLogger.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {
  appendArticleImportRouteRemapDeltasWithTx,
  type ArticleImportRouteLinkRecord,
  articleImportStoreWorkloadContext,
} from './articleImportStoreService.ts'
import {getComparisonProjectServingInvalidationService} from './comparisonProjectServingInvalidationService.ts'
import {getRequiredCovidenceBaseImportRouteId} from './covidenceBaseImportRoute.ts'
import {
  buildCovidencePackageConfig,
  getCovidencePackageConfig,
  getCovidencePackageCursor,
  getCovidencePackageRowsFromConfig,
  getCovidenceSameReviewResolutions,
} from './covidenceImportService.ts'
import {
  type CovidenceCandidateMatchKeys,
  type CovidenceMatchResolution,
  type CovidenceMatchTier,
  covidenceSameReviewListLimit,
} from './covidenceSameReviewMatching.ts'
import {getDataSourceQueryService} from './dataSourceQueryService.ts'

type CovidenceRematchTx = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
export type CovidenceRematchCandidateState = {
  articleKey: string
  currentArticleId: string | null
  keys: CovidenceCandidateMatchKeys
  resolution: CovidenceMatchResolution
  title: string | null
}
export type CovidenceRematchEntry = {
  articleKeys: string[]
  duplicateArticleId: string
  matchTier: CovidenceMatchTier
  targetArticleId: string
}
export type CovidenceRematchAmbiguousRecord = {
  articleIds: string[]
  articleKeys: string[]
  duplicateArticleId: string
  reason: 'ambiguous_match' | 'conflicting_targets' | 'shared_target'
  title: string | null
}
export type CovidenceRematchPlan = {
  alreadySharedRecordCount: number
  ambiguous: CovidenceRematchAmbiguousRecord[]
  entries: CovidenceRematchEntry[]
  notImportedRecordCount: number
  unmatched: Array<{articleKey: string; duplicateArticleId: string; title: string | null}>
  unmatchedRecordCount: number
}
type CovidenceRematchBlocker = {rowCount: number; tableName: string}
type CovidenceRematchProjectImpact = {
  humanPromptRows: number
  humanSummaryConflicts: number
  humanSummaryRows: number
  projectArticles: number
  projectId: string
}

const covidenceRematchChunkSize = 500
const covidenceRematchApplyBatchSize = 250
const covidenceRematchMatchTierOrder: CovidenceMatchTier[] = [
  'strong_identifier',
  'covidence_id',
  'reference_id',
  'title_year_first_author',
]
export const covidenceRematchRemappedTables = [
  'article_identifier',
  'article_import_route',
  'article_import_route_source_record',
  'judgment_human',
  'judgment_human_summary',
  'project_article',
  'review_import_article_hot_field',
] as const
export const covidenceRematchDerivedServingTables = [
  'import_run_article_delta',
  'review_change_delta',
  'review_selected_article_import_v4',
  'review_serving_dirty_work',
  'review_write_overlay',
] as const
const covidenceRematchIgnoredTables = new Set<string>([
  'article',
  ...covidenceRematchRemappedTables,
  ...covidenceRematchDerivedServingTables,
])

const getChunks = <TValue>(values: TValue[], chunkSize = covidenceRematchChunkSize): TValue[][] => {
  return values.length === 0
    ? []
    : values.length <= chunkSize
      ? [values]
      : [values.slice(0, chunkSize), ...getChunks(values.slice(chunkSize), chunkSize)]
}

const runChunks = async <TValue>(values: TValue[], work: (chunk: TValue[]) => Promise<void>) => {
  await getChunks(values).reduce<Promise<void>>(async (previousRun, chunk) => {
    await previousRun
    await work(chunk)
  }, Promise.resolve())
}

const queryChunks = async <TValue, TRow>(values: TValue[], query: (chunk: TValue[]) => Promise<TRow[]>) => {
  return await getChunks(values).reduce<Promise<TRow[]>>(async (rowsPromise, chunk) => {
    const rows = await rowsPromise

    return [...rows, ...(await query(chunk))]
  }, Promise.resolve([]))
}

const getUniqueSortedValues = (values: string[]) => {
  return Array.from(new Set(values)).sort((left, right) => {
    return left.localeCompare(right)
  })
}

const getCovidenceRematchStateTargetIds = (states: CovidenceRematchCandidateState[]) => {
  return getUniqueSortedValues(
    states.flatMap((state) => {
      return state.resolution.status === 'matched'
        ? [state.resolution.articleId]
        : state.resolution.status === 'ambiguous'
          ? state.resolution.articleIds
          : []
    }),
  )
}

const getCovidenceRematchEntryTier = (states: CovidenceRematchCandidateState[]) => {
  const tiers = states.flatMap((state) => {
    return state.resolution.status === 'matched' ? [state.resolution.matchTier] : []
  })

  return (
    covidenceRematchMatchTierOrder.find((tier) => {
      return tiers.includes(tier)
    }) ?? 'covidence_id'
  )
}

const getCovidenceRematchAmbiguousRecord = (
  duplicateArticleId: string,
  states: CovidenceRematchCandidateState[],
  reason: CovidenceRematchAmbiguousRecord['reason'],
): CovidenceRematchAmbiguousRecord => {
  return {
    articleIds: getCovidenceRematchStateTargetIds(states),
    articleKeys: states.map((state) => {
      return state.articleKey
    }),
    duplicateArticleId,
    reason,
    title: states[0]?.title ?? null,
  }
}

type CovidenceRematchGroupOutcome =
  | {entry: CovidenceRematchEntry; kind: 'entry'}
  | {kind: 'ambiguous'; record: CovidenceRematchAmbiguousRecord}
  | {kind: 'unmatched'; states: CovidenceRematchCandidateState[]}

const getCovidenceRematchGroupOutcome = (
  duplicateArticleId: string,
  states: CovidenceRematchCandidateState[],
): CovidenceRematchGroupOutcome => {
  const matchedStates = states.filter((state) => {
    return state.resolution.status === 'matched'
  })
  const targetIds = getCovidenceRematchStateTargetIds(matchedStates)
  const isUnmatched = states.every((state) => {
    return state.resolution.status === 'unmatched'
  })
  const isEntry =
    matchedStates.length === states.length && targetIds.length === 1 && targetIds[0] !== duplicateArticleId
  const hasAmbiguousMatch = states.some((state) => {
    return state.resolution.status === 'ambiguous'
  })

  return isUnmatched
    ? {kind: 'unmatched', states}
    : isEntry && targetIds[0]
      ? {
          entry: {
            articleKeys: states.map((state) => {
              return state.articleKey
            }),
            duplicateArticleId,
            matchTier: getCovidenceRematchEntryTier(states),
            targetArticleId: targetIds[0],
          },
          kind: 'entry',
        }
      : {
          kind: 'ambiguous',
          record: getCovidenceRematchAmbiguousRecord(
            duplicateArticleId,
            states,
            hasAmbiguousMatch ? 'ambiguous_match' : 'conflicting_targets',
          ),
        }
}

export const getCovidenceRematchPlan = (params: {
  candidateStates: CovidenceRematchCandidateState[]
  routeOnlyArticleIds: ReadonlySet<string>
}): CovidenceRematchPlan => {
  const statesByDuplicateId = params.candidateStates.reduce<Map<string, CovidenceRematchCandidateState[]>>(
    (stateMap, state) => {
      if (state.currentArticleId && params.routeOnlyArticleIds.has(state.currentArticleId)) {
        stateMap.set(state.currentArticleId, [...(stateMap.get(state.currentArticleId) ?? []), state])
      }

      return stateMap
    },
    new Map(),
  )
  const outcomes = Array.from(statesByDuplicateId.entries())
    .sort(([left], [right]) => {
      return left.localeCompare(right)
    })
    .map(([duplicateArticleId, states]) => {
      return {duplicateArticleId, outcome: getCovidenceRematchGroupOutcome(duplicateArticleId, states)}
    })
  const proposedEntries = outcomes.flatMap((outcome) => {
    return outcome.outcome.kind === 'entry' ? [outcome.outcome.entry] : []
  })
  const duplicateCountByTargetId = proposedEntries.reduce<Map<string, number>>((countMap, entry) => {
    return countMap.set(entry.targetArticleId, (countMap.get(entry.targetArticleId) ?? 0) + 1)
  }, new Map())
  const isSharedTargetEntry = (entry: CovidenceRematchEntry) => {
    return (duplicateCountByTargetId.get(entry.targetArticleId) ?? 0) > 1
  }
  const unmatchedStates = outcomes.flatMap((outcome) => {
    return outcome.outcome.kind === 'unmatched'
      ? outcome.outcome.states.map((state) => {
          return {duplicateArticleId: outcome.duplicateArticleId, state}
        })
      : []
  })

  return {
    alreadySharedRecordCount: params.candidateStates.filter((state) => {
      return state.currentArticleId !== null && !params.routeOnlyArticleIds.has(state.currentArticleId)
    }).length,
    ambiguous: [
      ...outcomes.flatMap((outcome) => {
        return outcome.outcome.kind === 'ambiguous' ? [outcome.outcome.record] : []
      }),
      ...proposedEntries.filter(isSharedTargetEntry).map((entry) => {
        return {
          articleIds: [entry.targetArticleId],
          articleKeys: entry.articleKeys,
          duplicateArticleId: entry.duplicateArticleId,
          reason: 'shared_target' as const,
          title:
            params.candidateStates.find((state) => {
              return state.articleKey === entry.articleKeys[0]
            })?.title ?? null,
        }
      }),
    ],
    entries: proposedEntries.filter((entry) => {
      return !isSharedTargetEntry(entry)
    }),
    notImportedRecordCount: params.candidateStates.filter((state) => {
      return state.currentArticleId === null
    }).length,
    unmatched: unmatchedStates.slice(0, covidenceSameReviewListLimit).map((unmatchedState) => {
      return {
        articleKey: unmatchedState.state.articleKey,
        duplicateArticleId: unmatchedState.duplicateArticleId,
        title: unmatchedState.state.title,
      }
    }),
    unmatchedRecordCount: unmatchedStates.length,
  }
}

type CovidenceRematchMapSource = {entries: CovidenceRematchEntry[]; kind: 'values'} | {kind: 'temp'}

const covidenceRematchMapTableName = 'temp_covidence_rematch_map'

const getCovidenceRematchMapValuesSql = (entries: CovidenceRematchEntry[]) => {
  return entries
    .map((entry) => {
      return `(${getQuotedStringList([entry.duplicateArticleId, entry.targetArticleId, entry.matchTier]).join(', ')})`
    })
    .join(', ')
}

const getCovidenceRematchMapCteSql = (source: CovidenceRematchMapSource) => {
  return source.kind === 'temp'
    ? `WITH rematch_map AS (SELECT duplicate_article_id, target_article_id, match_tier FROM ${covidenceRematchMapTableName})`
    : `WITH rematch_map AS (
        SELECT duplicate_article_id, target_article_id, match_tier
        FROM (VALUES ${getCovidenceRematchMapValuesSql(source.entries)}) AS map_values(duplicate_article_id, target_article_id, match_tier)
      )`
}

const createCovidenceRematchMapTable = async (tx: CovidenceRematchTx, entries: CovidenceRematchEntry[]) => {
  await tx.run(`
    DROP TABLE IF EXISTS ${covidenceRematchMapTableName};
    CREATE TEMP TABLE ${covidenceRematchMapTableName} (
      duplicate_article_id VARCHAR,
      target_article_id VARCHAR,
      match_tier VARCHAR
    );
  `)
  await runChunks(entries, async (entryChunk) => {
    await tx.run(`
      INSERT INTO ${covidenceRematchMapTableName} (duplicate_article_id, target_article_id, match_tier)
      VALUES ${getCovidenceRematchMapValuesSql(entryChunk)}
    `)
  })
}

const dropCovidenceRematchMapTable = async (tx: CovidenceRematchTx) => {
  await tx.run(`DROP TABLE IF EXISTS ${covidenceRematchMapTableName}`)
}

const getCovidenceRouteSourceRecordArticleIds = async (runner: CovidenceRematchTx, importRouteId: string) => {
  const rows = await runner.queryJson<{articleId: string; sourceRecordKey: string}>(`
    SELECT source_record_key AS sourceRecordKey, article_id AS articleId
    FROM app.article_import_route_source_record
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
      AND quarantined_at IS NULL
  `)

  return new Map(
    rows.map((row) => {
      return [row.sourceRecordKey, row.articleId]
    }),
  )
}

const getCovidenceRouteOnlyArticleIds = async (runner: CovidenceRematchTx, importRouteId: string) => {
  const importRouteIdSql = getSqlLiteral(importRouteId)
  const rows = await runner.queryJson<{articleId: string}>(`
    SELECT DISTINCT route_link.article_id AS articleId
    FROM (
      SELECT article_id
      FROM app.article_import_route
      WHERE import_route_id = ${importRouteIdSql}
      UNION
      SELECT article_id
      FROM app.article_import_route_source_record
      WHERE import_route_id = ${importRouteIdSql}
    ) route_link
    WHERE NOT EXISTS (
        SELECT 1
        FROM app.article_import_route other_link
        WHERE other_link.article_id = route_link.article_id
          AND other_link.import_route_id <> ${importRouteIdSql}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.article_import_route_source_record other_record
        WHERE other_record.article_id = route_link.article_id
          AND other_record.import_route_id <> ${importRouteIdSql}
      )
  `)

  return new Set(
    rows.map((row) => {
      return row.articleId
    }),
  )
}

const getCovidenceRematchAssertZeroTables = async (runner: CovidenceRematchTx) => {
  const rows = await runner.queryJson<{tableName: string}>(`
    SELECT DISTINCT table_name AS tableName
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND column_name = 'article_id'
    ORDER BY table_name ASC
  `)

  return rows
    .map((row) => {
      return row.tableName
    })
    .filter((tableName) => {
      return /^[a-z_][a-z0-9_]*$/.test(tableName) && !covidenceRematchIgnoredTables.has(tableName)
    })
}

const getCovidenceRematchBlockers = async (
  runner: CovidenceRematchTx,
  source: CovidenceRematchMapSource,
): Promise<CovidenceRematchBlocker[]> => {
  const tables = await getCovidenceRematchAssertZeroTables(runner)
  const isEmpty = source.kind === 'values' && source.entries.length === 0
  const rows =
    tables.length === 0 || isEmpty
      ? []
      : await runner.queryJson<{rowCount: number; tableName: string}>(`
          ${getCovidenceRematchMapCteSql(source)}
          ${tables
            .map((tableName) => {
              return `SELECT '${tableName}' AS tableName, CAST(COUNT(*) AS INTEGER) AS rowCount FROM app.${tableName} WHERE article_id IN (SELECT duplicate_article_id FROM rematch_map)`
            })
            .join(' UNION ALL ')}
        `)

  return rows
    .filter((row) => {
      return Number(row.rowCount) > 0
    })
    .map((row) => {
      return {rowCount: Number(row.rowCount), tableName: row.tableName}
    })
}

const getCovidenceRematchProjectImpact = async (runner: CovidenceRematchTx, entries: CovidenceRematchEntry[]) => {
  const rows =
    entries.length === 0
      ? []
      : await runner.queryJson<{kind: string; projectId: string; rowCount: number}>(`
          ${getCovidenceRematchMapCteSql({entries, kind: 'values'})}
          SELECT 'projectArticles' AS kind, project_article.project_id AS projectId, CAST(COUNT(*) AS INTEGER) AS rowCount
          FROM app.project_article project_article
          INNER JOIN rematch_map ON rematch_map.duplicate_article_id = project_article.article_id
          GROUP BY ALL
          UNION ALL
          SELECT 'humanSummaryRows' AS kind, summary.project_id AS projectId, CAST(COUNT(*) AS INTEGER) AS rowCount
          FROM app.judgment_human_summary summary
          INNER JOIN rematch_map ON rematch_map.duplicate_article_id = summary.article_id
          GROUP BY ALL
          UNION ALL
          SELECT 'humanSummaryConflicts' AS kind, summary.project_id AS projectId, CAST(COUNT(*) AS INTEGER) AS rowCount
          FROM app.judgment_human_summary summary
          INNER JOIN rematch_map ON rematch_map.duplicate_article_id = summary.article_id
          INNER JOIN app.judgment_human_summary target_summary
            ON target_summary.project_id = summary.project_id
            AND target_summary.article_id = rematch_map.target_article_id
          GROUP BY ALL
          UNION ALL
          SELECT 'humanPromptRows' AS kind, prompt_judgment.project_id AS projectId, CAST(COUNT(*) AS INTEGER) AS rowCount
          FROM app.judgment_human prompt_judgment
          INNER JOIN rematch_map ON rematch_map.duplicate_article_id = prompt_judgment.article_id
          GROUP BY ALL
        `)
  const impactByProject = rows.reduce<Map<string, CovidenceRematchProjectImpact>>((impactMap, row) => {
    const impact = impactMap.get(row.projectId) ?? {
      humanPromptRows: 0,
      humanSummaryConflicts: 0,
      humanSummaryRows: 0,
      projectArticles: 0,
      projectId: row.projectId,
    }
    const kind = row.kind as Exclude<keyof CovidenceRematchProjectImpact, 'projectId'>

    return impactMap.set(row.projectId, {...impact, [kind]: impact[kind] + Number(row.rowCount)})
  }, new Map())

  return Array.from(impactByProject.values()).sort((left, right) => {
    return left.projectId.localeCompare(right.projectId)
  })
}

const getCovidenceRematchMatchMetadataSql = (params: {baseImportRoute: string; columnSql: string}) => {
  return `json_merge_patch(
    COALESCE(${params.columnSql}, CAST('{}' AS JSON)),
    json_object(
      'covidenceSameReview',
      json_object(
        'baseImportRoute', ${getSqlLiteral(params.baseImportRoute)},
        'matchTier', rematch_map.match_tier,
        'rematchedFromArticleId', rematch_map.duplicate_article_id
      )
    )
  )`
}

type CovidenceRematchLinkRow = Omit<ArticleImportRouteLinkRecord, 'rawPayload'> & {
  targetArticleId: string
  targetLinkExists: boolean
}

const remapCovidenceRouteLinks = async (params: {
  baseImportRoute: string
  duplicateIdListSql: string
  importRouteId: string
  tx: CovidenceRematchTx
}) => {
  const importRouteIdSql = getSqlLiteral(params.importRouteId)
  const mapSql = `${covidenceRematchMapTableName} rematch_map`
  const linkRows = await params.tx.queryJson<CovidenceRematchLinkRow>(`
    SELECT
      link.article_id AS articleId,
      link.external_article_id AS externalArticleId,
      TO_JSON(link.import_metadata) AS importMetadata,
      link.import_route_id AS importRouteId,
      link.import_run_id AS importRunId,
      TO_JSON(link.match_metadata) AS matchMetadata,
      link.source_article_created_at AS sourceArticleCreatedAt,
      link.source_kind AS sourceKind,
      link.source_record_hash AS sourceRecordHash,
      link.source_record_key AS sourceRecordKey,
      rematch_map.target_article_id AS targetArticleId,
      EXISTS (
        SELECT 1
        FROM app.article_import_route target_link
        WHERE target_link.import_route_id = link.import_route_id
          AND target_link.article_id = rematch_map.target_article_id
      ) AS targetLinkExists
    FROM app.article_import_route link
    INNER JOIN ${mapSql} ON rematch_map.duplicate_article_id = link.article_id
    WHERE link.import_route_id = ${importRouteIdSql}
      AND link.article_id IN (${params.duplicateIdListSql})
  `)
  if (
    linkRows.some((row) => {
      return row.targetLinkExists
    })
  ) {
    await params.tx.run(`
      DELETE FROM app.article_import_route
      WHERE import_route_id = ${importRouteIdSql}
        AND article_id IN (
          SELECT rematch_map.duplicate_article_id
          FROM ${mapSql}
          WHERE rematch_map.duplicate_article_id IN (${params.duplicateIdListSql})
            AND EXISTS (
            SELECT 1
            FROM app.article_import_route target_link
            WHERE target_link.import_route_id = ${importRouteIdSql}
              AND target_link.article_id = rematch_map.target_article_id
          )
        )
    `)
  }

  await params.tx.run(`
    UPDATE app.article_import_route
    SET
      article_id = rematch_map.target_article_id,
      match_metadata = ${getCovidenceRematchMatchMetadataSql({baseImportRoute: params.baseImportRoute, columnSql: 'article_import_route.match_metadata'})},
      updated_at = now()
    FROM ${mapSql}
    WHERE article_import_route.import_route_id = ${importRouteIdSql}
      AND article_import_route.article_id = rematch_map.duplicate_article_id
      AND article_import_route.article_id IN (${params.duplicateIdListSql})
  `)
  await params.tx.run(`
    UPDATE app.article_import_route_source_record
    SET
      article_id = rematch_map.target_article_id,
      match_metadata = ${getCovidenceRematchMatchMetadataSql({baseImportRoute: params.baseImportRoute, columnSql: 'article_import_route_source_record.match_metadata'})},
      updated_at = now()
    FROM ${mapSql}
    WHERE article_import_route_source_record.import_route_id = ${importRouteIdSql}
      AND article_import_route_source_record.article_id = rematch_map.duplicate_article_id
      AND article_import_route_source_record.article_id IN (${params.duplicateIdListSql})
  `)
  await params.tx.run(`
    UPDATE app.review_import_article_hot_field
    SET article_id = rematch_map.target_article_id
    FROM ${mapSql}
    WHERE review_import_article_hot_field.import_route_id = ${importRouteIdSql}
      AND review_import_article_hot_field.article_id = rematch_map.duplicate_article_id
      AND review_import_article_hot_field.article_id IN (${params.duplicateIdListSql})
  `)
  await params.tx.run(`
    UPDATE app.article_identifier
    SET
      article_id = rematch_map.target_article_id,
      is_primary = article_identifier.is_primary AND NOT EXISTS (
        SELECT 1
        FROM app.article_identifier target_identifier
        WHERE target_identifier.article_id = rematch_map.target_article_id
          AND target_identifier.kind = article_identifier.kind
          AND target_identifier.is_primary
      )
    FROM ${mapSql}
    WHERE article_identifier.article_id = rematch_map.duplicate_article_id
      AND article_identifier.article_id IN (${params.duplicateIdListSql})
  `)
  await appendArticleImportRouteRemapDeltasWithTx(
    params.tx,
    linkRows.map((row) => {
      return {
        record: {
          ...row,
          importMetadata: getJsonValue(row.importMetadata),
          matchMetadata: getJsonValue(row.matchMetadata),
          rawPayload: null,
        },
        targetArticleId: row.targetArticleId,
        targetLinkExists: row.targetLinkExists,
      }
    }),
  )
}

type CovidenceRematchProjectArticleRow = {
  createdAt: string | null
  duplicateArticleId: string
  id: string
  importedFromProjectId: string | null
  projectId: string
  targetArticleId: string
  targetExists: boolean
}

const remapCovidenceProjectArticles = async (params: {duplicateIdListSql: string; tx: CovidenceRematchTx}) => {
  const rows = await params.tx.queryJson<CovidenceRematchProjectArticleRow>(`
    SELECT
      project_article.id,
      project_article.project_id AS projectId,
      project_article.article_id AS duplicateArticleId,
      project_article.imported_from_project_id AS importedFromProjectId,
      CAST(project_article.created_at AS VARCHAR) AS createdAt,
      rematch_map.target_article_id AS targetArticleId,
      EXISTS (
        SELECT 1
        FROM app.project_article target_project_article
        WHERE target_project_article.project_id = project_article.project_id
          AND target_project_article.article_id = rematch_map.target_article_id
      ) AS targetExists
    FROM app.project_article project_article
    INNER JOIN ${covidenceRematchMapTableName} rematch_map ON rematch_map.duplicate_article_id = project_article.article_id
    WHERE project_article.article_id IN (${params.duplicateIdListSql})
  `)

  if (rows.length === 0) {
    return
  }

  await params.tx.run(`
    DELETE FROM app.project_article
    WHERE article_id IN (${params.duplicateIdListSql})
  `)

  const insertRows = rows
    .filter((row) => {
      return !row.targetExists
    })
    .map((row) => {
      return {...row, newId: globalThis.crypto.randomUUID()}
    })
  const insertedRows = await queryChunks(insertRows, (insertRowChunk) => {
    return params.tx.queryJson<{articleId: string; projectArticleId: string; projectId: string}>(`
      INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id, created_at)
      VALUES ${insertRowChunk
        .map((row) => {
          return `(${[row.newId, row.projectId, row.targetArticleId, row.importedFromProjectId]
            .map((value) => {
              return getSqlLiteral(value)
            })
            .join(', ')}, COALESCE(TRY_CAST(${getSqlLiteral(row.createdAt)} AS TIMESTAMPTZ), now()))`
        })
        .join(', ')}
      ON CONFLICT(project_id, article_id) DO NOTHING
      RETURNING id AS projectArticleId, project_id AS projectId, article_id AS articleId
    `)
  })

  await appendProjectScopeArticleReviewServingDeltas(params.tx, [
    ...rows.map((row) => {
      return {
        articleId: row.duplicateArticleId,
        changeKind: 'projectScope.article.removed' as const,
        projectArticleId: row.id,
        projectId: row.projectId,
        sourceMutationKey: `covidenceRematchProjectArticle.delete|${row.projectId}|${row.id}`,
        sourceOperation: 'delete' as const,
      }
    }),
    ...insertedRows.map((row) => {
      return {
        articleId: row.articleId,
        changeKind: 'projectScope.article.added' as const,
        projectArticleId: row.projectArticleId,
        projectId: row.projectId,
        sourceMutationKey: `covidenceRematchProjectArticle.insert|${row.projectId}|${row.projectArticleId}`,
        sourceOperation: 'insert' as const,
      }
    }),
  ])
}

type CovidenceRematchHumanRow = {
  answer: string | null
  comment: string | null
  duplicateArticleId: string
  id: string
  isAnswered: boolean | null
  origin: string | null
  projectId: string
  promptId: string | null
  targetArticleId: string
  targetRowId: string | null
  updatedAt: string | null
}

const getCovidenceRematchHumanRows = async (params: {
  duplicateIdListSql: string
  table: 'judgment_human' | 'judgment_human_summary'
  tx: CovidenceRematchTx
}) => {
  const isPromptTable = params.table === 'judgment_human'

  return await params.tx.queryJson<CovidenceRematchHumanRow>(`
    SELECT
      duplicate_row.id,
      duplicate_row.project_id AS projectId,
      ${isPromptTable ? 'duplicate_row.prompt_id' : 'NULL'} AS promptId,
      duplicate_row.article_id AS duplicateArticleId,
      duplicate_row.answer,
      ${isPromptTable ? 'duplicate_row.is_answered' : 'NULL'} AS isAnswered,
      ${isPromptTable ? 'duplicate_row.comment' : 'NULL'} AS comment,
      ${isPromptTable ? 'NULL' : 'duplicate_row.origin'} AS origin,
      CAST(duplicate_row.updated_at AS VARCHAR) AS updatedAt,
      rematch_map.target_article_id AS targetArticleId,
      target_row.id AS targetRowId
    FROM app.${params.table} duplicate_row
    INNER JOIN ${covidenceRematchMapTableName} rematch_map ON rematch_map.duplicate_article_id = duplicate_row.article_id
    LEFT JOIN app.${params.table} target_row
      ON target_row.project_id = duplicate_row.project_id
      AND target_row.article_id = rematch_map.target_article_id
      ${isPromptTable ? 'AND target_row.prompt_id = duplicate_row.prompt_id' : ''}
    WHERE duplicate_row.article_id IN (${params.duplicateIdListSql})
  `)
}

const getCovidenceRematchHumanJudgmentKey = (row: CovidenceRematchHumanRow, articleId: string) => {
  return `${row.projectId}:${articleId}:${row.promptId ?? 'summary'}`
}

const getCovidenceRematchHumanDeltas = (params: {
  rows: CovidenceRematchHumanRow[]
  table: 'judgment_human' | 'judgment_human_summary'
  updatedAt: Date
}) => {
  return params.rows.flatMap((row) => {
    const duplicateKey = getCovidenceRematchHumanJudgmentKey(row, row.duplicateArticleId)
    const targetKey = getCovidenceRematchHumanJudgmentKey(row, row.targetArticleId)
    const sharedFields = {
      answer: row.answer,
      projectId: row.projectId,
      sourceTable: `app.${params.table}`,
      sourceUpdatedAt: params.updatedAt,
      ...(row.promptId ? {promptId: row.promptId} : {}),
    }

    return [
      {
        ...sharedFields,
        articleId: row.duplicateArticleId,
        humanJudgmentKey: duplicateKey,
        sourceMutationKey: `covidenceRematchHuman.delete|${duplicateKey}|${params.updatedAt.toISOString()}`,
        sourceOperation: 'delete' as const,
        sourceRowId: duplicateKey,
      },
      {
        ...sharedFields,
        articleId: row.targetArticleId,
        humanJudgmentKey: targetKey,
        sourceMutationKey: `covidenceRematchHuman.upsert|${targetKey}|${params.updatedAt.toISOString()}`,
        sourceOperation: 'upsert' as const,
        sourceRowId: targetKey,
      },
    ]
  })
}

const getCovidenceRematchHumanConflictUpdateSql = (params: {
  row: CovidenceRematchHumanRow
  table: 'judgment_human' | 'judgment_human_summary'
}) => {
  const promptColumnsSql =
    params.table === 'judgment_human'
      ? `is_answered = ${getSqlLiteral(params.row.isAnswered)}, comment = ${getSqlLiteral(params.row.comment)},`
      : `origin = ${getSqlLiteral(params.row.origin)},`

  return `
    UPDATE app.${params.table}
    SET
      answer = ${getSqlLiteral(params.row.answer)},
      ${promptColumnsSql}
      updated_at = COALESCE(TRY_CAST(${getSqlLiteral(params.row.updatedAt)} AS TIMESTAMPTZ), now())
    WHERE id = ${getSqlLiteral(params.row.targetRowId)}
  `
}

const remapCovidenceHumanJudgments = async (params: {
  duplicateIdListSql: string
  table: 'judgment_human' | 'judgment_human_summary'
  tx: CovidenceRematchTx
  updatedAt: Date
}) => {
  const rows = await getCovidenceRematchHumanRows(params)
  const conflictRows = rows.filter((row) => {
    return row.targetRowId !== null
  })
  const movedRows = rows.filter((row) => {
    return row.targetRowId === null
  })

  await conflictRows.reduce<Promise<void>>(async (previousRun, row) => {
    await previousRun
    await params.tx.run(getCovidenceRematchHumanConflictUpdateSql({row, table: params.table}))
  }, Promise.resolve())

  if (conflictRows.length > 0) {
    await params.tx.run(`
      DELETE FROM app.${params.table}
      WHERE id IN (${getQuotedStringList(
        conflictRows.map((row) => {
          return row.id
        }),
      ).join(', ')})
    `)
  }

  if (movedRows.length > 0) {
    await params.tx.run(`
      UPDATE app.${params.table}
      SET article_id = rematch_map.target_article_id
      FROM ${covidenceRematchMapTableName} rematch_map
      WHERE ${params.table}.article_id = rematch_map.duplicate_article_id
        AND ${params.table}.article_id IN (${params.duplicateIdListSql})
    `)
  }

  await appendHumanJudgmentReviewServingDeltas(params.tx, getCovidenceRematchHumanDeltas({...params, rows}))
  await markCovidenceRematchComparisonServingStale({rows, table: params.table, tx: params.tx})

  return {conflictCount: conflictRows.length, rowCount: rows.length}
}

const markCovidenceRematchComparisonServingStale = async (params: {
  rows: CovidenceRematchHumanRow[]
  table: 'judgment_human' | 'judgment_human_summary'
  tx: CovidenceRematchTx
}) => {
  const invalidationService = getComparisonProjectServingInvalidationService()
  const articleRows = params.rows.flatMap((row) => {
    return [
      {articleId: row.duplicateArticleId, projectId: row.projectId, promptId: row.promptId ?? ''},
      {articleId: row.targetArticleId, projectId: row.projectId, promptId: row.promptId ?? ''},
    ]
  })

  await runChunks(articleRows, async (rowChunk) => {
    await (params.table === 'judgment_human_summary'
      ? invalidationService.markComparisonProjectsServingStaleForHumanSummaryJudgments(
          rowChunk.map((row) => {
            return {articleId: row.articleId, projectId: row.projectId}
          }),
          {runner: params.tx},
        )
      : invalidationService.markComparisonProjectsServingStaleForHumanPromptJudgments(
          rowChunk.map((row) => {
            return {articleId: row.articleId, promptId: row.promptId}
          }),
          {runner: params.tx},
        ))
  })
}

const insertCovidenceArticleMerges = async (params: {
  baseImportRouteId: string
  importRouteId: string
  tx: CovidenceRematchTx
}) => {
  await params.tx.run(`
    INSERT INTO app.article_merge (merged_article_id, target_article_id, import_route_id, base_import_route_id, match_tier)
    SELECT
      duplicate_article_id,
      target_article_id,
      ${getSqlLiteral(params.importRouteId)},
      ${getSqlLiteral(params.baseImportRouteId)},
      match_tier
    FROM ${covidenceRematchMapTableName}
    ON CONFLICT(merged_article_id) DO NOTHING
  `)
}

const getCovidenceRematchIdListBlockers = async (runner: CovidenceRematchTx, duplicateIdListSql: string) => {
  const tables = await getCovidenceRematchAssertZeroTables(runner)
  const rows =
    tables.length === 0
      ? []
      : await runner.queryJson<{rowCount: number; tableName: string}>(
          tables
            .map((tableName) => {
              return `SELECT '${tableName}' AS tableName, CAST(COUNT(*) AS INTEGER) AS rowCount FROM app.${tableName} WHERE article_id IN (${duplicateIdListSql})`
            })
            .join(' UNION ALL '),
        )

  return rows.filter((row) => {
    return Number(row.rowCount) > 0
  })
}

const assertCovidenceRematchBatchCurrent = async (params: {
  entries: CovidenceRematchEntry[]
  importRouteId: string
  tx: CovidenceRematchTx
}) => {
  const importRouteIdSql = getSqlLiteral(params.importRouteId)
  const duplicateIdListSql = getCovidenceRematchIdListSql(params.entries, 'duplicateArticleId')
  const targetIdListSql = getCovidenceRematchIdListSql(params.entries, 'targetArticleId')
  const [stateRow] = await params.tx.queryJson<{
    otherRouteCount: number
    routeRecordCount: number
    targetCount: number
  }>(`
    SELECT
      (SELECT CAST(COUNT(DISTINCT id) AS INTEGER) FROM app.article WHERE id IN (${targetIdListSql})) AS targetCount,
      (
        SELECT CAST(COUNT(DISTINCT article_id) AS INTEGER)
        FROM app.article_import_route_source_record
        WHERE import_route_id = ${importRouteIdSql}
          AND article_id IN (${duplicateIdListSql})
      ) AS routeRecordCount,
      (
        SELECT CAST(COUNT(*) AS INTEGER)
        FROM (
          SELECT article_id FROM app.article_import_route
          WHERE article_id IN (${duplicateIdListSql}) AND import_route_id <> ${importRouteIdSql}
          UNION ALL
          SELECT article_id FROM app.article_import_route_source_record
          WHERE article_id IN (${duplicateIdListSql}) AND import_route_id <> ${importRouteIdSql}
        ) other_route
      ) AS otherRouteCount
  `)
  const expectedTargetCount = new Set(
    params.entries.map((entry) => {
      return entry.targetArticleId
    }),
  ).size
  const isCurrent =
    Number(stateRow?.targetCount) === expectedTargetCount
    && Number(stateRow?.routeRecordCount) === params.entries.length
    && Number(stateRow?.otherRouteCount) === 0

  if (!isCurrent) {
    throw new HttpError(
      409,
      `Covidence rematch plan changed while applying (${JSON.stringify(stateRow)}); run it again`,
    )
  }

  const blockers = await getCovidenceRematchIdListBlockers(params.tx, duplicateIdListSql)

  if (blockers.length > 0) {
    throw new HttpError(409, `Covidence rematch is blocked by rows in ${JSON.stringify(blockers)}`)
  }
}

const getCovidenceRematchIdListSql = (
  entries: CovidenceRematchEntry[],
  key: 'duplicateArticleId' | 'targetArticleId',
) => {
  return getQuotedStringList(
    entries.map((entry) => {
      return entry[key]
    }),
  ).join(', ')
}

const applyCovidenceRematchBatch = async (params: {
  baseImportRoute: string
  baseImportRouteId: string
  entries: CovidenceRematchEntry[]
  importRouteId: string
  tx: CovidenceRematchTx
  updatedAt: Date
}) => {
  const duplicateIdListSql = getCovidenceRematchIdListSql(params.entries, 'duplicateArticleId')

  await createCovidenceRematchMapTable(params.tx, params.entries)
  await assertCovidenceRematchBatchCurrent(params)
  await remapCovidenceRouteLinks({...params, duplicateIdListSql})
  await remapCovidenceProjectArticles({duplicateIdListSql, tx: params.tx})
  await remapCovidenceHumanJudgments({...params, duplicateIdListSql, table: 'judgment_human_summary'})
  await remapCovidenceHumanJudgments({...params, duplicateIdListSql, table: 'judgment_human'})
  await insertCovidenceArticleMerges(params)
  await dropCovidenceRematchMapTable(params.tx)
}

const deleteMergedCovidenceArticleBatch = async (params: {articleIds: string[]; tx: CovidenceRematchTx}) => {
  const articleIdListSql = getQuotedStringList(params.articleIds).join(', ')
  const [existingRow] = await params.tx.queryJson<{articleCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS articleCount
    FROM app.article
    WHERE id IN (${articleIdListSql})
  `)

  await params.tx.run(`
    DELETE FROM app.article
    WHERE id IN (${articleIdListSql})
  `)
  await params.tx.run(`
    UPDATE app.article_merge
    SET article_deleted_at = now()
    WHERE merged_article_id IN (${articleIdListSql})
      AND article_deleted_at IS NULL
  `)

  return Number(existingRow?.articleCount ?? 0)
}

const getPendingCovidenceArticleMergeIds = async (runner: CovidenceRematchTx, importRouteId: string) => {
  const rows = await runner.queryJson<{articleId: string}>(`
    SELECT article_merge.merged_article_id AS articleId
    FROM app.article_merge article_merge
    WHERE article_merge.import_route_id = ${getSqlLiteral(importRouteId)}
      AND article_merge.article_deleted_at IS NULL
    ORDER BY article_merge.merged_article_id ASC
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getRequiredCovidenceRematchDataSource = async (dataSourceId: string) => {
  const dataSource = await getDataSourceQueryService().getDataSourceById(dataSourceId)

  if (!dataSource) {
    throw new HttpError(404, 'Data source not found')
  }

  const config = getCovidencePackageConfig(dataSource.cursor)
  const importRoute = dataSource.importRoute

  if (!config || !importRoute?.startsWith('covidence:')) {
    throw new HttpError(400, 'Data source is not a Covidence import')
  }

  return {config, dataSource, importRoute}
}

const assertCovidenceRematchImportIdle = async (dataSourceId: string) => {
  const [state] = await getAppDatabaseService().queryJson<{status: string}>(`
    SELECT status
    FROM app.data_source_import_state
    WHERE data_source_id = ${getSqlLiteral(dataSourceId)}
    LIMIT 1
  `)

  if (state?.status === 'running') {
    throw new HttpError(409, 'Data source import is running; wait for it to finish before rematching')
  }
}

const getCovidenceRematchImportRouteId = async (importRoute: string) => {
  const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.import_route
    WHERE route = ${getSqlLiteral(importRoute)}
    LIMIT 1
  `)

  if (!row) {
    throw new HttpError(400, `Import route '${importRoute}' does not exist`)
  }

  return row.id
}

const getCovidenceRematchRemappedByTier = (entries: CovidenceRematchEntry[]) => {
  return entries.reduce<Record<CovidenceMatchTier, number>>(
    (counts, entry) => {
      counts[entry.matchTier] += 1

      return counts
    },
    {covidence_id: 0, reference_id: 0, strong_identifier: 0, title_year_first_author: 0},
  )
}

const updateCovidenceRematchDataSourceConfig = async (params: {
  baseImportRoute: string
  config: NonNullable<ReturnType<typeof getCovidencePackageConfig>>
  dataSourceId: string
  tx: CovidenceRematchTx
}) => {
  if (params.config.baseImportRoute === params.baseImportRoute) {
    return
  }

  await params.tx.run(`
    UPDATE app.data_source
    SET cursor = ${getSqlLiteral(
      getCovidencePackageCursor(
        buildCovidencePackageConfig({
          baseImportRoute: params.baseImportRoute,
          files: params.config.files,
          mode: params.config.mode,
        }),
      ),
    )},
        updated_at = now()
    WHERE id = ${getSqlLiteral(params.dataSourceId)}
  `)
}

type CovidenceRematchApplyInput = {
  baseImportRoute: string
  baseImportRouteId: string
  config: NonNullable<ReturnType<typeof getCovidencePackageConfig>>
  dataSourceId: string
  entries: CovidenceRematchEntry[]
  importRouteId: string
}
type CovidenceRematchApplyResult = {deletedArticles: number; remappedArticleCount: number}

const runningCovidenceRematchApplies = new Map<string, Promise<CovidenceRematchApplyResult>>()

export const getRunningCovidenceRematchApply = (dataSourceId: string) => {
  return runningCovidenceRematchApplies.get(dataSourceId) ?? null
}

const deletePendingCovidenceArticleMerges = async (importRouteId: string) => {
  const database = getAppDatabaseService()
  const pendingIds = await getPendingCovidenceArticleMergeIds(database, importRouteId)

  return await getChunks(pendingIds, covidenceRematchApplyBatchSize).reduce<Promise<number>>(
    async (deletedPromise, articleIdChunk) => {
      const deletedCount = await deletedPromise
      const chunkDeletedCount = await database.transaction(async (tx) => {
        return await deleteMergedCovidenceArticleBatch({articleIds: articleIdChunk, tx})
      }, articleImportStoreWorkloadContext)

      return deletedCount + chunkDeletedCount
    },
    Promise.resolve(0),
  )
}

const applyCovidenceRematch = async (input: CovidenceRematchApplyInput): Promise<CovidenceRematchApplyResult> => {
  const database = getAppDatabaseService()
  const updatedAt = new Date()

  await database.transaction(async (tx) => {
    await updateCovidenceRematchDataSourceConfig({...input, tx})
  }, articleImportStoreWorkloadContext)

  const batchDeletedArticles = await getChunks(input.entries, covidenceRematchApplyBatchSize).reduce<Promise<number>>(
    async (deletedPromise, entryChunk) => {
      const deletedCount = await deletedPromise

      await database.transaction(async (tx) => {
        await applyCovidenceRematchBatch({...input, entries: entryChunk, tx, updatedAt})
      }, articleImportStoreWorkloadContext)

      const chunkDeletedCount = await database.transaction(async (tx) => {
        return await deleteMergedCovidenceArticleBatch({
          articleIds: entryChunk.map((entry) => {
            return entry.duplicateArticleId
          }),
          tx,
        })
      }, articleImportStoreWorkloadContext)

      return deletedCount + chunkDeletedCount
    },
    Promise.resolve(0),
  )
  const leftoverDeletedArticles = await deletePendingCovidenceArticleMerges(input.importRouteId)

  return {deletedArticles: batchDeletedArticles + leftoverDeletedArticles, remappedArticleCount: input.entries.length}
}

const startCovidenceRematchApply = (input: CovidenceRematchApplyInput) => {
  const startedAtMs = Date.now()
  const logAttrs = {
    baseImportRoute: input.baseImportRoute,
    dataSourceId: input.dataSourceId,
    remappedArticleCount: input.entries.length,
  }
  const applyPromise = applyCovidenceRematch(input)
    .then((result) => {
      writeRuntimeOperatorLogEvent({
        attrs: {...logAttrs, ...result, durationMs: Date.now() - startedAtMs},
        event: 'covidence-rematch.completed',
        message: `[covidenceRematch] merged ${result.remappedArticleCount} duplicate articles of data source ${input.dataSourceId}`,
        severity: 'INFO',
      })

      return result
    })
    .catch((error: unknown) => {
      writeRuntimeOperatorLogEvent({
        attrs: {...logAttrs, durationMs: Date.now() - startedAtMs, error},
        event: 'covidence-rematch.failed',
        message: `[covidenceRematch] rematch failed for data source ${input.dataSourceId}; run it again to resume`,
        severity: 'ERROR',
        terminalArgs: [error],
      })

      throw error
    })
    .finally(() => {
      runningCovidenceRematchApplies.delete(input.dataSourceId)
    })

  runningCovidenceRematchApplies.set(input.dataSourceId, applyPromise)
  applyPromise.catch(() => {
    return undefined
  })
}

export const runCovidenceRematch = async (params: {baseImportRoute: string; dataSourceId: string; dryRun: boolean}) => {
  const {config, importRoute} = await getRequiredCovidenceRematchDataSource(params.dataSourceId)
  const importRouteId = await getCovidenceRematchImportRouteId(importRoute)
  const baseImportRouteId = await getRequiredCovidenceBaseImportRouteId({
    baseImportRoute: params.baseImportRoute,
    importRoute,
  })

  await assertCovidenceRematchImportIdle(params.dataSourceId)

  const database = getAppDatabaseService()
  const packageRows = getCovidencePackageRowsFromConfig(config)
  const routeOnlyArticleIds = await getCovidenceRouteOnlyArticleIds(database, importRouteId)
  const sourceRecordArticleIds = await getCovidenceRouteSourceRecordArticleIds(database, importRouteId)
  const resolutions = await getCovidenceSameReviewResolutions({
    baseImportRoute: params.baseImportRoute,
    candidates: packageRows.candidates,
    excludedArticleIds: routeOnlyArticleIds,
    importRoute,
  })
  const plan = getCovidenceRematchPlan({
    candidateStates: resolutions.resolutions.map((resolution) => {
      return {...resolution, currentArticleId: sourceRecordArticleIds.get(resolution.articleKey) ?? null}
    }),
    routeOnlyArticleIds,
  })
  const blockers = await getCovidenceRematchBlockers(database, {entries: plan.entries, kind: 'values'})
  const projectsTouched = await getCovidenceRematchProjectImpact(database, plan.entries)
  const pendingMergeCount = (await getPendingCovidenceArticleMergeIds(database, importRouteId)).length
  const isApplyRunning = runningCovidenceRematchApplies.has(params.dataSourceId)
  const summary = {
    alreadySharedRecordCount: plan.alreadySharedRecordCount,
    ambiguous: plan.ambiguous.slice(0, covidenceSameReviewListLimit),
    ambiguousCount: plan.ambiguous.length,
    applyRunning: isApplyRunning,
    applyStarted: false,
    baseImportRoute: params.baseImportRoute,
    blockers,
    candidateCount: packageRows.candidates.length,
    dryRun: params.dryRun,
    importRoute,
    notImportedRecordCount: plan.notImportedRecordCount,
    pendingMergeCount,
    projectsTouched,
    remappedArticleCount: plan.entries.length,
    remappedByTier: getCovidenceRematchRemappedByTier(plan.entries),
    unmatched: plan.unmatched,
    unmatchedRecordCount: plan.unmatchedRecordCount,
  }

  if (params.dryRun) {
    return summary
  }

  if (isApplyRunning) {
    throw new HttpError(409, 'A Covidence rematch for this data source is already running')
  }

  if (blockers.length > 0) {
    throw new HttpError(409, `Covidence rematch is blocked by rows in ${JSON.stringify(blockers)}`)
  }

  startCovidenceRematchApply({
    baseImportRoute: params.baseImportRoute,
    baseImportRouteId,
    config,
    dataSourceId: params.dataSourceId,
    entries: plan.entries,
    importRouteId,
  })

  return {...summary, applyRunning: true, applyStarted: true}
}

export type CovidenceRematchSummary = Awaited<ReturnType<typeof runCovidenceRematch>>

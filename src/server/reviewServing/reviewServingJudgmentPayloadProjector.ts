import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingListMode} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {getReviewServingPayloadPatchManifest} from './reviewServingDisplayPayloadProjector.ts'
import {
  getDeleteReviewServingProjectorRowsStatement,
  type ReviewServingProjectorWriterDatabase,
  writeReviewServingProjectorComponent,
} from './reviewServingProjectorWriter.ts'

export type ReviewServingJudgmentPayloadProjectorDatabase = ReviewServingProjectorWriterDatabase

export type ProjectReviewServingJudgmentPayloadInput = {
  acknowledgeClaims?: boolean
  baseGeneration?: number
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
  claims?: readonly ReviewServingDirtyWorkClaim[]
  definitionVersion?: string
  listModeKeys: readonly ReviewServingListMode[]
  modelId: string
  projectId: string
  projectionIdentity?: string
  reviewConfigHash: string
  skipReplacementDeletes?: boolean
  snapshotId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type ProjectReviewServingJudgmentPayloadArticleRangeInput = ProjectReviewServingJudgmentPayloadInput & {
  chunkEndArticleId: string
  chunkStartArticleId: string
}

type JudgmentPayloadKind = 'human' | 'llm'
type ProjectReviewServingJudgmentPayloadProjectSettings = {
  modelId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

const rowNumberSql = ['row', 'number'].join('_')

const getClaimArticleIds = (claims: readonly ReviewServingDirtyWorkClaim[] = []) => {
  return [
    ...new Set(
      claims
        .map((claim) => {
          return claim.articleId ?? (claim.scopeKind === 'article' ? (claim.scopeId.split(':').at(-1) ?? null) : null)
        })
        .filter((articleId) => {
          return articleId !== null && articleId.trim().length > 0
        }) as string[],
    ),
  ]
}

const getArticleIdClaims = (input: {
  articleIds: readonly string[]
  projectId: string
  projectionIdentity: string
}): ReviewServingDirtyWorkClaim[] => {
  return [...new Set(input.articleIds)]
    .filter((articleId) => {
      return articleId.trim().length > 0
    })
    .map((articleId, index) => {
      return {
        articleId,
        dirtyKind: 'lazy-detail-hydration',
        dirtyRangeEnd: null,
        dirtyRangeStart: null,
        dirtyWorkId: `lazy-detail-hydration:${input.projectId}:${articleId}:${index}`,
        firstSourceHighWaterMark: 0,
        latestDeltaId: null,
        latestSourceHighWaterMark: 0,
        projectId: input.projectId,
        projectionComponent: 'payload',
        projectionIdentity: input.projectionIdentity,
        scopeId: `article:${articleId}`,
        scopeKind: 'article',
        sourcePartition: 'lazy-detail-hydration',
        status: 'running',
      }
    })
}

const getValuesCte = (columnName: string, values: readonly string[]) => {
  return values.length === 0
    ? ''
    : `${columnName}_filter(${columnName}) AS (SELECT * FROM (VALUES ${values
        .map((value) => {
          return `(${getSqlLiteral(value)})`
        })
        .join(', ')}))`
}

const hasChunkArticleRange = (input: {chunkEndArticleId?: string | null; chunkStartArticleId?: string | null}) => {
  return input.chunkStartArticleId !== undefined || input.chunkEndArticleId !== undefined
}

const getArticleRangePredicate = (input: {
  alias?: string
  chunkEndArticleId?: string | null
  chunkStartArticleId?: string | null
}) => {
  const columnPrefix = input.alias === undefined ? '' : `${input.alias}.`
  const startPredicate =
    input.chunkStartArticleId === null || input.chunkStartArticleId === undefined
      ? ''
      : `AND ${columnPrefix}article_id >= ${getSqlLiteral(input.chunkStartArticleId)}`
  const endPredicate =
    input.chunkEndArticleId === null || input.chunkEndArticleId === undefined
      ? ''
      : `AND ${columnPrefix}article_id <= ${getSqlLiteral(input.chunkEndArticleId)}`

  return `${startPredicate}
          ${endPredicate}`
}

const getArticleRangeFilterCte = (ranges: readonly ProjectReviewServingJudgmentPayloadArticleRangeInput[]) => {
  return `article_range_filter(chunk_start_article_id, chunk_end_article_id) AS (
      SELECT * FROM (VALUES ${ranges
        .map((range) => {
          return `(${getSqlLiteral(range.chunkStartArticleId)}, ${getSqlLiteral(range.chunkEndArticleId)})`
        })
        .join(', ')})
    )`
}

const getActiveArticleCte = (
  input: ProjectReviewServingJudgmentPayloadInput,
  options: {ranges?: readonly ProjectReviewServingJudgmentPayloadArticleRangeInput[]} = {},
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const dirtyArticleCte = getValuesCte('article_id', articleIds)
  const dirtyJoinSql =
    articleIds.length === 0 ? '' : 'INNER JOIN article_id_filter dirty ON dirty.article_id = scope.article_id'
  const rangeJoinSql =
    options.ranges === undefined
      ? ''
      : `INNER JOIN article_range_filter range
        ON scope.article_id >= range.chunk_start_article_id
        AND scope.article_id <= range.chunk_end_article_id`

  return `${options.ranges === undefined ? '' : `${getArticleRangeFilterCte(options.ranges)},`}
    ${dirtyArticleCte}${dirtyArticleCte.length > 0 ? ',' : ''}
    active_article AS (
      SELECT DISTINCT scope.article_id
      FROM mart.project_scope_article scope
      ${dirtyJoinSql}
      ${rangeJoinSql}
      WHERE scope.project_id = ${getSqlLiteral(input.projectId)}
        AND (scope.in_curated_scope OR scope.in_route_scope)
        ${options.ranges === undefined ? getArticleRangePredicate({alias: 'scope', ...input}) : ''}
    )`
}

const shouldProjectLlmPayload = (listModeKeys: readonly ReviewServingListMode[]) => {
  return listModeKeys.some((listModeKey) => {
    return listModeKey === 'llm' || listModeKey === 'both'
  })
}

const shouldProjectHumanPayload = (listModeKeys: readonly ReviewServingListMode[]) => {
  return listModeKeys.some((listModeKey) => {
    return listModeKey === 'human' || listModeKey === 'both'
  })
}

const getRequestedPayloadKinds = (listModeKeys: readonly ReviewServingListMode[]) => {
  return [
    shouldProjectLlmPayload(listModeKeys) ? 'llm' : null,
    shouldProjectHumanPayload(listModeKeys) ? 'human' : null,
  ].filter((payloadKind): payloadKind is JudgmentPayloadKind => {
    return payloadKind !== null
  })
}

const getNonNegativeElapsedMs = (startedAtMs: number) => {
  return Math.max(0, Date.now() - startedAtMs)
}

const getPayloadManifestInputs = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return claims.length === 0
    || input.acknowledgeClaims === false
    || input.baseGeneration === undefined
    || input.definitionVersion === undefined
    || input.projectionIdentity === undefined
    ? []
    : [
        getReviewServingPayloadPatchManifest(
          {
            baseGeneration: input.baseGeneration,
            claims,
            definitionVersion: input.definitionVersion,
            projectId: input.projectId,
            projectionIdentity: input.projectionIdentity,
          },
          'payload',
        ),
      ]
}

const getPayloadWatermark = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  const sourceHighWaterMark = Math.max(
    0,
    ...claims.map((claim) => {
      return claim.latestSourceHighWaterMark
    }),
  )

  return getPayloadManifestInputs(input, claims).length === 0
    ? undefined
    : {
        projectId: input.projectId,
        projectionComponent: 'payload' as const,
        projectorName: 'review-serving-judgment-payload-projector',
        sourceHighWaterMark,
        sourcePartition: claims[0]?.sourcePartition ?? 'review-change',
      }
}

const getPayloadAcknowledgements = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return claims.length > 0 && input.acknowledgeClaims !== false ? claims : []
}

const getPayloadProjectionManifests = (
  input: ProjectReviewServingJudgmentPayloadInput,
  claims: readonly ReviewServingDirtyWorkClaim[],
) => {
  return getPayloadManifestInputs(input, claims)
}

const getReplacementDeleteStatements = (
  input: ProjectReviewServingJudgmentPayloadInput,
  payloadKinds: readonly JudgmentPayloadKind[],
) => {
  if (input.skipReplacementDeletes) {
    return []
  }

  if (hasChunkArticleRange(input)) {
    return []
  }

  const claims = input.claims ?? []
  const articleIds = getClaimArticleIds(claims)
  const shouldReplaceBroadScope = claims.some((claim) => {
    return claim.scopeKind === 'project' || claim.scopeKind === 'prompt'
  })

  const tables = ['mart.review_article_judgment_detail_serving_v4'] as const

  return articleIds.length === 0 && !shouldReplaceBroadScope
    ? payloadKinds.flatMap((payloadKind) => {
        return tables.map((table) => {
          return `
              DELETE FROM ${table} detail
              WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
                AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
                AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
                AND detail.payload_kind = ${getSqlLiteral(payloadKind)}
            `
        })
      })
    : payloadKinds.flatMap((payloadKind) => {
        const articlePredicate = articleIds.length === 0 ? {} : {article_id: articleIds}

        return tables.map((table) => {
          return getDeleteReviewServingProjectorRowsStatement({
            predicates: {
              ...articlePredicate,
              payload_kind: payloadKind,
              project_id: input.projectId,
              review_config_hash: input.reviewConfigHash,
              snapshot_id: input.snapshotId,
            },
            table,
          })
        })
      })
}

const getLlmJudgmentDirectInsertStatement = (
  input: ProjectReviewServingJudgmentPayloadInput,
  options: {ranges?: readonly ProjectReviewServingJudgmentPayloadArticleRangeInput[]} = {},
) => {
  return !shouldProjectLlmPayload(input.listModeKeys)
    ? null
    : `
      INSERT INTO mart.review_article_judgment_detail_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        payload_kind,
        article_id,
        prompt_id,
        prompt_order,
        judgment_id,
        is_answered,
        answered_original,
        answered_original_as_array,
        judgment_created_at,
        human_comment,
        placeholder_kind,
        detail_updated_at
      )
      WITH ${getActiveArticleCte(input, options)},
      enabled_prompt AS (
        SELECT
          prompt.id AS prompt_id,
          project_prompt.prompt_order
        FROM app.project_prompt project_prompt
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
          AND project_prompt.enabled
          AND NOT project_prompt.archived
          AND COALESCE(prompt.archived, FALSE) = FALSE
      ),
      latest_judgment AS (
        SELECT
          judgment.*,
          ${rowNumberSql}() OVER (PARTITION BY judgment.article_id, judgment.prompt_id ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC) AS judgment_rank
        FROM app."judgment" judgment
        INNER JOIN active_article active
          ON active.article_id = judgment.article_id
        WHERE judgment.model_id = ${getSqlLiteral(input.modelId)}
          AND judgment.use_title = ${getSqlLiteral(input.useTitle)}
          AND judgment.use_abstract = ${getSqlLiteral(input.useAbstract)}
          AND judgment.use_fulltext = ${getSqlLiteral(input.useFulltext)}
          AND judgment.use_fulltext_no_images = ${getSqlLiteral(input.useFulltextNoImages)}
          AND judgment.deleted_at IS NULL
      ),
      payload AS (
        SELECT
          judgment.article_id,
          prompt.prompt_id,
          prompt.prompt_order,
          judgment.id AS judgment_id,
          judgment.created_at AS judgment_created_at,
          judgment.updated_at AS judgment_updated_at,
          judgment.is_answered,
          judgment.answered_original,
          judgment.answered_original_as_array,
          NULL AS placeholder_kind
        FROM latest_judgment judgment
        INNER JOIN enabled_prompt prompt
          ON prompt.prompt_id = judgment.prompt_id
        WHERE judgment.judgment_rank = 1
      )
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        'llm' AS payload_kind,
        payload.article_id,
        payload.prompt_id,
        payload.prompt_order,
        payload.judgment_id,
        payload.is_answered,
        payload.answered_original,
        payload.answered_original_as_array,
        payload.judgment_created_at,
        NULL AS human_comment,
        payload.placeholder_kind,
        COALESCE(payload.judgment_updated_at, current_timestamp) AS detail_updated_at
      FROM payload
      WHERE NOT EXISTS (
        SELECT 1
        FROM mart.review_article_judgment_detail_serving_v4 existing
        WHERE existing.project_id = ${getSqlLiteral(input.projectId)}
          AND existing.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND existing.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND existing.payload_kind = 'llm'
          AND existing.article_id = payload.article_id
          AND existing.prompt_id = payload.prompt_id
      )
    `
}

const getHumanJudgmentDirectInsertStatement = (
  input: ProjectReviewServingJudgmentPayloadInput,
  options: {ranges?: readonly ProjectReviewServingJudgmentPayloadArticleRangeInput[]} = {},
) => {
  return !shouldProjectHumanPayload(input.listModeKeys)
    ? null
    : `
      INSERT INTO mart.review_article_judgment_detail_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        payload_kind,
        article_id,
        prompt_id,
        prompt_order,
        judgment_id,
        is_answered,
        answered_original,
        answered_original_as_array,
        judgment_created_at,
        human_comment,
        placeholder_kind,
        detail_updated_at
      )
      WITH ${getActiveArticleCte(input, options)},
      enabled_prompt AS (
        SELECT
          prompt.id AS prompt_id,
          project_prompt.prompt_order,
          prompt.original_text AS prompt_original_text,
          prompt.prompt_heading,
          prompt.type AS prompt_type,
          project_prompt.criteria_disposition AS prompt_criteria_disposition
        FROM app.project_prompt project_prompt
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        WHERE project_prompt.project_id = ${getSqlLiteral(input.projectId)}
          AND project_prompt.enabled
          AND NOT project_prompt.archived
          AND COALESCE(prompt.archived, FALSE) = FALSE
      ),
      payload AS (
        SELECT
          active.article_id,
          prompt.prompt_id,
          prompt.prompt_order,
          judgment_human.id AS human_judgment_id,
          judgment_human.is_answered,
          judgment_human.answer,
          judgment_human.comment,
          judgment_human.created_at AS human_judgment_created_at,
          judgment_human.updated_at AS human_judgment_updated_at,
          'human_prompt' AS payload_reference_kind,
          prompt.prompt_original_text,
          prompt.prompt_heading,
          prompt.prompt_type,
          prompt.prompt_criteria_disposition
        FROM active_article active
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
          AND COALESCE(project.human_judgment_mode, 'prompt') = 'prompt'
        INNER JOIN app."judgment_human" judgment_human
          ON judgment_human.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
          AND judgment_human.article_id = active.article_id
        INNER JOIN enabled_prompt prompt
          ON prompt.prompt_id = judgment_human.prompt_id
        UNION ALL
        SELECT
          active.article_id,
          'summary' AS prompt_id,
          -1 AS prompt_order,
          judgment_human_summary.id AS human_judgment_id,
          NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL AS is_answered,
          judgment_human_summary.answer,
          NULL AS comment,
          judgment_human_summary.created_at AS human_judgment_created_at,
          judgment_human_summary.updated_at AS human_judgment_updated_at,
          'human_summary' AS payload_reference_kind,
          'Overall human screening decision' AS prompt_original_text,
          NULL AS prompt_heading,
          'summary' AS prompt_type,
          NULL AS prompt_criteria_disposition
        FROM active_article active
        INNER JOIN app.project project
          ON project.id = ${getSqlLiteral(input.projectId)}
          AND COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
        INNER JOIN app."judgment_human_summary" judgment_human_summary
          ON judgment_human_summary.project_id = ${getSqlLiteral(input.projectId)}
          AND judgment_human_summary.article_id = active.article_id
      )
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        'human' AS payload_kind,
        payload.article_id,
        payload.prompt_id,
        payload.prompt_order,
        payload.human_judgment_id AS judgment_id,
        payload.is_answered,
        payload.answer AS answered_original,
        NULL AS answered_original_as_array,
        payload.human_judgment_created_at AS judgment_created_at,
        payload.comment AS human_comment,
        NULL AS placeholder_kind,
        COALESCE(payload.human_judgment_updated_at, current_timestamp) AS detail_updated_at
      FROM payload
      WHERE NOT EXISTS (
        SELECT 1
        FROM mart.review_article_judgment_detail_serving_v4 existing
        WHERE existing.project_id = ${getSqlLiteral(input.projectId)}
          AND existing.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND existing.snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND existing.payload_kind = 'human'
          AND existing.article_id = payload.article_id
          AND existing.prompt_id = payload.prompt_id
      )
    `
}

const getDirectSqlWriterDiagnostics = (input: {statementCount: number}) => {
  return {
    component: 'payload' as const,
    diagnostics: {
      phaseTimings: {},
      records: {
        batchCount: 0,
        batchesByTable: {},
        dedupedRecordCount: 0,
        dedupedRecordsByTable: {},
        inputRecordCount: 0,
        inputRecordsByTable: {},
        writeMsByTable: {},
      },
      statements: {count: input.statementCount},
    },
    promotedSnapshotId: null,
  }
}

const getDirectJudgmentPayloadCount = async (
  input: ProjectReviewServingJudgmentPayloadInput & {payloadKind: JudgmentPayloadKind},
  database: ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  const articleIds = getClaimArticleIds(input.claims)
  const articlePredicate =
    articleIds.length === 0
      ? ''
      : `AND detail.article_id IN (${articleIds
          .map((articleId) => {
            return getSqlLiteral(articleId)
          })
          .join(', ')})`
  const [row] = await database.queryJson<{rowCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
    FROM mart.review_article_judgment_detail_serving_v4 detail
    WHERE detail.project_id = ${getSqlLiteral(input.projectId)}
      AND detail.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND detail.snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND detail.payload_kind = ${getSqlLiteral(input.payloadKind)}
      ${articlePredicate}
      ${getArticleRangePredicate({alias: 'detail', ...input})}
  `)

  return row?.rowCount ?? 0
}

const projectReviewServingJudgmentPayloadRowsDirect = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase,
  measure: <T>(phase: string, operation: () => Promise<T>) => Promise<T>,
) => {
  const requestedPayloadKinds = getRequestedPayloadKinds(input.listModeKeys)
  const claims = input.claims ?? []
  const insertStatements = [
    getLlmJudgmentDirectInsertStatement(input),
    getHumanJudgmentDirectInsertStatement(input),
  ].filter((statement): statement is string => {
    return statement !== null
  })
  const statements = [...getReplacementDeleteStatements(input, requestedPayloadKinds), ...insertStatements]
  const shouldUseSequentialRebuildWrites = claims.length === 0
  const writerResult = await measure('writerMs', async () => {
    if (shouldUseSequentialRebuildWrites) {
      await statements.reduce<Promise<void>>(async (previous, statement) => {
        await previous
        await database.run(statement)
      }, Promise.resolve())

      return getDirectSqlWriterDiagnostics({statementCount: statements.length})
    }

    return writeReviewServingProjectorComponent(
      {
        acknowledgements: getPayloadAcknowledgements(input, claims),
        component: 'payload',
        projectionManifests: getPayloadProjectionManifests(input, claims),
        records: [],
        statements,
        watermark: getPayloadWatermark(input, claims),
      },
      database,
    )
  })
  const [llmRowCount, humanRowCount] = await measure('postWriteCountMs', async () => {
    return Promise.all([
      !shouldProjectLlmPayload(input.listModeKeys)
        ? 0
        : getDirectJudgmentPayloadCount({...input, payloadKind: 'llm'}, database),
      !shouldProjectHumanPayload(input.listModeKeys)
        ? 0
        : getDirectJudgmentPayloadCount({...input, payloadKind: 'human'}, database),
    ])
  })

  return {
    diagnosticsJson: {
      judgmentPayloadProjector: {
        directSqlWriter: true,
        humanMaterializedRecordCount: 0,
        humanSourceRowCount: 0,
        llmMaterializedRecordCount: 0,
        llmSourceRowCount: 0,
        materializedRecordCount: 0,
        writer: writerResult.diagnostics,
      },
    },
    humanRowCount,
    llmRowCount,
  }
}

export const projectReviewServingJudgmentPayloadRows = async (
  input: ProjectReviewServingJudgmentPayloadInput,
  database: ReviewServingJudgmentPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  const phaseTimings: Record<string, number> = {}
  const measure = async <T>(phase: string, operation: () => Promise<T>) => {
    const startedAtMs = Date.now()
    const result = await operation()
    phaseTimings[phase] = getNonNegativeElapsedMs(startedAtMs)
    return result
  }
  const result = await projectReviewServingJudgmentPayloadRowsDirect(input, database, measure)

  return {
    diagnosticsJson: {...result.diagnosticsJson, phaseTimings},
    humanRowCount: result.humanRowCount,
    llmRowCount: result.llmRowCount,
  }
}

const getProjectReviewServingJudgmentPayloadProjectSettings = async (
  projectId: string,
  database: Pick<ReviewServingJudgmentPayloadProjectorDatabase, 'queryJson'>,
) => {
  const [project] = await database.queryJson<ProjectReviewServingJudgmentPayloadProjectSettings>(`
    SELECT
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return project ?? null
}

export const ensureReviewServingJudgmentPayloadRowsForArticleSet = async (
  input: {
    articleIds: readonly string[]
    listModeKeys: readonly ReviewServingListMode[]
    projectId: string
    reviewConfigHash: string
    snapshotId: string
  },
  database: ReviewServingJudgmentPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  const articleIds = [...new Set(input.articleIds)].filter((articleId) => {
    return articleId.trim().length > 0
  })

  if (articleIds.length === 0) {
    return {articleCount: 0, humanRowCount: 0, llmRowCount: 0, status: 'skipped' as const}
  }

  const project = await getProjectReviewServingJudgmentPayloadProjectSettings(input.projectId, database)

  if (project === null) {
    return {articleCount: articleIds.length, humanRowCount: 0, llmRowCount: 0, status: 'missingProject' as const}
  }

  const result = await projectReviewServingJudgmentPayloadRows(
    {
      acknowledgeClaims: false,
      claims: getArticleIdClaims({articleIds, projectId: input.projectId, projectionIdentity: 'lazy-detail-hydration'}),
      listModeKeys: input.listModeKeys,
      modelId: project.modelId,
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
      useAbstract: project.useAbstract,
      useFulltext: project.useFulltext,
      useFulltextNoImages: project.useFulltextNoImages,
      useTitle: project.useTitle,
    },
    database,
  )

  return {articleCount: articleIds.length, ...result, status: 'completed' as const}
}

const canUseSetBasedJudgmentPayloadRangeInsert = (
  ranges: readonly ProjectReviewServingJudgmentPayloadArticleRangeInput[],
) => {
  const [firstRange] = ranges

  return (
    firstRange !== undefined
    && ranges.every((range) => {
      return (
        (range.claims === undefined || range.claims.length === 0)
        && range.chunkEndArticleId !== null
        && range.chunkEndArticleId !== undefined
        && range.chunkStartArticleId !== null
        && range.chunkStartArticleId !== undefined
        && range.listModeKeys.join('\n') === firstRange.listModeKeys.join('\n')
        && range.modelId === firstRange.modelId
        && range.projectId === firstRange.projectId
        && range.reviewConfigHash === firstRange.reviewConfigHash
        && range.snapshotId === firstRange.snapshotId
        && range.useAbstract === firstRange.useAbstract
        && range.useFulltext === firstRange.useFulltext
        && range.useFulltextNoImages === firstRange.useFulltextNoImages
        && range.useTitle === firstRange.useTitle
      )
    })
  )
}

export const projectReviewServingJudgmentPayloadArticleRanges = async (
  params: {ranges: readonly ProjectReviewServingJudgmentPayloadArticleRangeInput[]},
  database: ReviewServingJudgmentPayloadProjectorDatabase = getAppDatabaseService() as ReviewServingJudgmentPayloadProjectorDatabase,
) => {
  const [firstRange] = params.ranges

  if (firstRange === undefined) {
    return {rangeCount: 0, status: 'completed' as const}
  }

  const statements = canUseSetBasedJudgmentPayloadRangeInsert(params.ranges)
    ? [
        getLlmJudgmentDirectInsertStatement(firstRange, {ranges: params.ranges}),
        getHumanJudgmentDirectInsertStatement(firstRange, {ranges: params.ranges}),
      ].filter((statement): statement is string => {
        return statement !== null
      })
    : params.ranges.flatMap((range) => {
        const requestedPayloadKinds = getRequestedPayloadKinds(range.listModeKeys)
        const insertStatements = [
          getLlmJudgmentDirectInsertStatement(range),
          getHumanJudgmentDirectInsertStatement(range),
        ].filter((statement): statement is string => {
          return statement !== null
        })

        return [...getReplacementDeleteStatements(range, requestedPayloadKinds), ...insertStatements]
      })

  await writeReviewServingProjectorComponent(
    {acknowledgements: [], component: 'payload', projectionManifests: [], records: [], statements},
    database,
  )

  return {rangeCount: params.ranges.length, status: 'completed' as const}
}

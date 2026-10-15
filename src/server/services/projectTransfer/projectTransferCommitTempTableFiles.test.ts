import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {getSqlLiteral} from '../appQueryHelpers.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import {loadProjectTransferCommitIdMapTables, type ProjectTransferCommitIdMaps} from './projectTransferCommitIdMaps.ts'
import type {ProjectTransferCommitPromotionResult} from './projectTransferCommitRollback.ts'
import {
  getCommitWriterTempTableFiles,
  getCommitWriterTempTables,
  loadProjectTransferCommitWriterTempTables,
} from './projectTransferCommitWriter.ts'
import {getProjectTransferOperationTableNames} from './projectTransferOperationTables.ts'
import type {ProjectTransferArticlePayloadRecord} from './projectTransferPayloadSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'

type Runner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type LegacyFileTempTable =
  | 'articleCreates'
  | 'articleFieldFills'
  | 'articleIdentifiers'
  | 'articleRoutePlan'
  | 'humanReviewPlan'
  | 'judgmentAssessmentPlan'
  | 'judgmentPlan'
  | 'projectRoutePlan'

const sessionId = 'temp-table-parity-session'

const trickyStrings = [
  "it's",
  'say "hi"',
  'back\\slash \\n literal',
  'tab\there',
  'line\nbreak',
  'crlf\r\nend',
  'é ü ß Å',
  '中文 テスト',
  '🧪 emoji 👩‍🔬',
  ' line separator ',
  '',
  ' ',
  ' leading and trailing ',
  '{"json":"lookalike"}',
  '[1,2]',
  'null',
  'true',
  'TRUE',
  '1e21',
  '0042',
  "'; DROP TABLE app.article; --",
  '$.path[0]',
  'x'.repeat(5_000),
]

const trickyFillValues: unknown[] = [
  null,
  'plain summary',
  '',
  'null',
  0,
  -1.5,
  1e21,
  0.1 + 0.2,
  2 ** 70,
  true,
  false,
  [],
  ['Ada Lovelace', null, 'Émile "Q" O\'Brien'],
  {},
  {nested: {deep: [1, 'two', null, {quote: '"q"', unicode: '中文 🧪'}]}, zeta: 1, alpha: 2},
  '2026-01-01T00:00:00.000Z',
  'y'.repeat(20_000),
]

const withRuntimeRoot = async <T>(work: (cwd: string) => Promise<T>) => {
  const cwd = mkdtempSync(join(tmpdir(), `f2-project-transfer-temp-table-files-${process.pid}-`))

  try {
    return await work(cwd)
  } finally {
    rmSync(cwd, {force: true, recursive: true})
  }
}

const withRunner = async <T>(work: (runner: Runner) => Promise<T>) => {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  const runner: Runner = {
    queryJson: async <TRow>(statement: string) => {
      return (await connection.runAndReadAll(statement)).getRowObjectsJson() as TRow[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
  }

  try {
    return await work(runner)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

const getTricky = (index: number) => {
  return trickyStrings[index % trickyStrings.length] ?? ''
}

const getCommitIdMaps = (): ProjectTransferCommitIdMaps => {
  const trickyMap = Object.fromEntries(
    trickyStrings.map((value, index) => {
      return [`source ${value} ${index}`, `target ${getTricky(index + 3)} ${index}`]
    }),
  )
  const generatedMap = Object.fromEntries(
    Array.from({length: 20_000}, (_value, index) => {
      return [`source-judgment-${index}`, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`]
    }),
  )

  return {
    articleIdBySourceId: trickyMap,
    articleIdentifierIdBySourceKey: {'{"kind":"doi","normalizedValue":"10.1/é\'\\"x"}': 'identifier-target'},
    articleImportRouteIdBySourceId: {},
    commitId: 'commit-parity',
    generatedAt: '2026-10-15T00:00:00.000Z',
    generatedTargetIds: {},
    humanJudgmentIdBySourceId: {'human-1': 'human-target-1'},
    humanJudgmentSummaryIdBySourceId: {},
    judgmentAssessmentIdBySourceId: {'assessment-1': 'assessment-target-1'},
    judgmentIdBySourceId: generatedMap,
    modelIdBySourceId: {'model "quoted"': 'model-target'},
    projectArticleIdBySourceArticleId: {'source-a': 'project-article-a'},
    projectIdBySourceId: {'source-project': 'target-project'},
    projectImportRouteIdBySourceId: {'route-1': 'project-route-target-1'},
    projectPromptIdBySourceId: {'project-prompt-1': 'project-prompt-target-1'},
    promptIdBySourceId: {'prompt-1': 'prompt-target-1'},
    providerConnectionIdBySourceId: {'provider-1': 'provider-target-1'},
    reviewIdBySourceId: {'review-1': 'review-target-1'},
    routeIdBySourceId: {'route-1': 'route-target-1'},
    schemaVersion: 1,
    transferHistoryId: 'history-target',
  }
}

const getEmptyCommitIdMaps = (): ProjectTransferCommitIdMaps => {
  return {
    ...getCommitIdMaps(),
    articleIdBySourceId: {},
    articleIdentifierIdBySourceKey: {},
    humanJudgmentIdBySourceId: {},
    judgmentAssessmentIdBySourceId: {},
    judgmentIdBySourceId: {},
    modelIdBySourceId: {},
    projectArticleIdBySourceArticleId: {},
    projectIdBySourceId: {},
    projectImportRouteIdBySourceId: {},
    projectPromptIdBySourceId: {},
    promptIdBySourceId: {},
    providerConnectionIdBySourceId: {},
    reviewIdBySourceId: {},
    routeIdBySourceId: {},
  }
}

const getLegacyIdMapRows = (maps: ProjectTransferCommitIdMaps) => {
  const mapKinds = [
    ['article', maps.articleIdBySourceId],
    ['articleIdentifier', maps.articleIdentifierIdBySourceKey],
    ['articleImportRoute', maps.articleImportRouteIdBySourceId],
    ['humanJudgment', maps.humanJudgmentIdBySourceId],
    ['humanJudgmentSummary', maps.humanJudgmentSummaryIdBySourceId],
    ['judgment', maps.judgmentIdBySourceId],
    ['judgmentAssessment', maps.judgmentAssessmentIdBySourceId],
    ['model', maps.modelIdBySourceId],
    ['project', maps.projectIdBySourceId],
    ['projectArticle', maps.projectArticleIdBySourceArticleId],
    ['projectImportRoute', maps.projectImportRouteIdBySourceId],
    ['projectPrompt', maps.projectPromptIdBySourceId],
    ['prompt', maps.promptIdBySourceId],
    ['providerConnection', maps.providerConnectionIdBySourceId],
    ['review', maps.reviewIdBySourceId],
    ['route', maps.routeIdBySourceId],
  ] as const

  return [
    ...mapKinds.flatMap(([kind, mapped]) => {
      return Object.entries(mapped).map(([sourceId, targetId]) => {
        return {kind, sourceId, targetId}
      })
    }),
    {kind: 'transferHistory', sourceId: maps.commitId, targetId: maps.transferHistoryId},
  ]
}

const loadLegacyIdMapTable = async ({
  maps,
  runner,
  tableName,
}: {
  maps: ProjectTransferCommitIdMaps
  runner: Runner
  tableName: string
}) => {
  const rowsSql = getLegacyIdMapRows(maps)
    .map((entry) => {
      return `(${getSqlLiteral(entry.kind)}, ${getSqlLiteral(entry.sourceId)}, ${getSqlLiteral(entry.targetId)})`
    })
    .join(', ')

  await runner.run(`
    DROP TABLE IF EXISTS ${tableName};
    CREATE TEMP TABLE ${tableName} (
      map_kind VARCHAR NOT NULL,
      source_id VARCHAR NOT NULL,
      target_id VARCHAR NOT NULL
    );
    ${rowsSql === '' ? '' : `INSERT INTO ${tableName} (map_kind, source_id, target_id) VALUES ${rowsSql};`}
  `)
}

const legacyStringField = (field: string) => {
  return `json_extract_string(row_json, '$.${field}')`
}

const legacyBooleanField = (field: string) => {
  return `COALESCE(TRY_CAST(${legacyStringField(field)} AS BOOLEAN), FALSE)`
}

const legacySelectListByTable: Record<LegacyFileTempTable, string[]> = {
  articleCreates: [`${legacyStringField('sourceArticleId')} AS source_article_id`],
  articleFieldFills: [
    `${legacyStringField('sourceArticleId')} AS source_article_id`,
    `${legacyStringField('targetArticleId')} AS target_article_id`,
    `${legacyStringField('field')} AS field`,
    `json_extract(row_json, '$.value') AS value_json`,
  ],
  articleIdentifiers: [
    `${legacyStringField('sourceArticleId')} AS source_article_id`,
    `${legacyStringField('sourceKey')} AS source_key`,
    `${legacyStringField('kind')} AS kind`,
    `${legacyStringField('normalizedValue')} AS normalized_value`,
    `${legacyStringField('source')} AS source`,
    `${legacyBooleanField('isPrimary')} AS is_primary`,
  ],
  articleRoutePlan: [
    `${legacyStringField('action')} AS action`,
    `${legacyBooleanField('snapshotProjectArticleLink')} AS snapshot_project_article_link`,
    `${legacyStringField('sourceArticleId')} AS source_article_id`,
    `${legacyStringField('sourceArticleImportRouteId')} AS source_article_import_route_id`,
    `${legacyStringField('sourceImportRouteId')} AS source_import_route_id`,
    `${legacyStringField('targetImportRouteId')} AS target_import_route_id`,
  ],
  humanReviewPlan: [
    `${legacyStringField('action')} AS action`,
    `${legacyStringField('kind')} AS kind`,
    `${legacyStringField('sourceId')} AS source_id`,
    `${legacyStringField('targetArticleId')} AS target_article_id`,
    `${legacyStringField('targetPromptId')} AS target_prompt_id`,
  ],
  judgmentAssessmentPlan: [
    `${legacyStringField('action')} AS action`,
    `${legacyStringField('sourceJudgmentAssessmentId')} AS source_judgment_assessment_id`,
    `${legacyStringField('sourceJudgmentId')} AS source_judgment_id`,
    `${legacyStringField('targetAssessmentId')} AS target_assessment_id`,
    `${legacyStringField('targetJudgmentId')} AS target_judgment_id`,
  ],
  judgmentPlan: [
    `${legacyStringField('action')} AS action`,
    `${legacyStringField('sourceJudgmentId')} AS source_judgment_id`,
    `${legacyStringField('targetArticleId')} AS target_article_id`,
    `${legacyStringField('targetJudgmentId')} AS target_judgment_id`,
    `${legacyStringField('targetModelId')} AS target_model_id`,
    `${legacyStringField('targetPromptId')} AS target_prompt_id`,
  ],
  projectRoutePlan: [
    `${legacyStringField('action')} AS action`,
    `${legacyStringField('sourceImportRouteId')} AS source_import_route_id`,
    `${legacyStringField('sourceProjectImportRouteId')} AS source_project_import_route_id`,
    `${legacyStringField('targetImportRouteId')} AS target_import_route_id`,
  ],
}

const legacyFileTempTables = Object.keys(legacySelectListByTable) as LegacyFileTempTable[]

const getLegacyJsonArrayRowsSourceSql = (rows: readonly unknown[]) => {
  return rows.length === 0
    ? `(SELECT CAST(NULL AS JSON) AS row_json WHERE FALSE) AS rows`
    : `UNNEST(json_extract(CAST(${getSqlLiteral(JSON.stringify(rows))} AS JSON), '$[*]')) AS rows(row_json)`
}

const loadLegacyWriterTempTables = async ({
  rowsByTable,
  runner,
  tables,
}: {
  rowsByTable: Record<LegacyFileTempTable, readonly object[]>
  runner: Runner
  tables: ReturnType<typeof getCommitWriterTempTables>
}) => {
  await runner.run(
    legacyFileTempTables
      .map((table) => {
        return `
          CREATE TEMP TABLE ${tables[table]} AS
          SELECT ${legacySelectListByTable[table].join(', ')}
          FROM ${getLegacyJsonArrayRowsSourceSql(rowsByTable[table])}
        `
      })
      .join(';\n'),
  )
}

const getTableSchema = (runner: Runner, tableName: string) => {
  return runner.queryJson<{columnName: string; dataType: string; isNullable: boolean}>(`
    SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable
    FROM duckdb_columns()
    WHERE table_name = ${getSqlLiteral(tableName)}
    ORDER BY column_index
  `)
}

const getTableRows = (runner: Runner, tableName: string) => {
  return runner.queryJson<Record<string, unknown>>(`SELECT * FROM ${tableName} ORDER BY ALL`)
}

const getSymmetricDifferenceCount = async ({left, right, runner}: {left: string; right: string; runner: Runner}) => {
  const [row] = await runner.queryJson<{count: number}>(`
    SELECT COUNT(*)::INTEGER AS count
    FROM (
      (SELECT * FROM ${left} EXCEPT ALL SELECT * FROM ${right})
      UNION ALL
      (SELECT * FROM ${right} EXCEPT ALL SELECT * FROM ${left})
    ) difference
  `)

  return row?.count ?? -1
}

const expectTablesIdentical = async ({left, right, runner}: {left: string; right: string; runner: Runner}) => {
  const [leftSchema, rightSchema, leftRows, rightRows] = await Promise.all([
    getTableSchema(runner, left),
    getTableSchema(runner, right),
    getTableRows(runner, left),
    getTableRows(runner, right),
  ])

  expect(leftSchema.length).toBeGreaterThan(0)
  expect(rightSchema).toEqual(leftSchema)
  expect(rightRows).toEqual(leftRows)
  expect(await getSymmetricDifferenceCount({left, right, runner})).toBe(0)

  return leftRows.length
}

const getArticles = () => {
  return trickyStrings.slice(0, 12).map((value, index) => {
    return {
      arxivId: index % 3 === 0 ? `2401.${String(index).padStart(5, '0')}` : null,
      doi: `10.1000/${encodeURIComponent(value)}-${index}`,
      pubmedId: index % 2 === 0 ? String(100_000 + index) : '',
      sourceArticleId: `source-article ${value} ${index}`,
    }
  }) as unknown as ProjectTransferArticlePayloadRecord[]
}

const getPlan = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  const articleMatches = articles.map((article, index) => {
    return {
      action: index % 2 === 0 ? 'create' : 'reuse',
      candidates: [],
      conflicts: [],
      identifierKeys: [],
      packageArticleId: null,
      selectedTargetArticleId: index % 2 === 0 ? null : `target-article-${index}`,
      sourceArticleId: article.sourceArticleId,
    }
  })
  const articleRoutePlan = trickyStrings.map((value, index) => {
    return {
      action: ['exists', 'omit', 'write'][index % 3],
      snapshotProjectArticleLink: index % 2 === 0,
      sourceArticleId: `source-article ${value}`,
      sourceArticleImportRouteId: `source-article-route ${getTricky(index + 1)}`,
      sourceImportRouteId: `source-route ${index % 4}`,
      targetArticleId: index % 5 === 0 ? null : `target-article ${value}`,
      targetImportRouteId: index % 3 === 0 ? null : `target-route ${getTricky(index + 2)}`,
      unsafeProjectIds: [value],
    }
  })
  const projectRoutePlan = Array.from({length: 4}, (_value, index) => {
    return {
      action: index === 3 ? 'omit' : 'link',
      dateBoundedOutsideExportedArticleCount: index,
      dateBoundedRouteArticleCount: index * 2,
      outsideExportedArticleCount: 0,
      sourceImportRouteId: `source-route ${index}`,
      sourceProjectImportRouteId: `source-project-route ${getTricky(index)}`,
      targetImportRouteId: index === 3 ? null : `target-route ${getTricky(index + 2)}`,
    }
  })
  const judgmentPlan = Array.from({length: 3_000}, (_value, index) => {
    return {
      action: index % 7 === 0 ? 'reuse' : 'insert',
      conflictCodes: index % 11 === 0 ? ['code-a', getTricky(index)] : [],
      inputSignatureMatches: index % 13 === 0 ? null : true,
      physicalKey: `physical ${getTricky(index)}`,
      provenanceKind: 'currentReviewRows',
      reviewVisibleKey: null,
      sourceJudgmentId: `source-judgment ${index} ${getTricky(index)}`,
      targetArticleId: index % 5 === 0 ? null : `target-article ${getTricky(index + 1)}`,
      targetJudgmentId: index % 7 === 0 ? `target-judgment-${index}` : null,
      targetModelId: `target-model ${getTricky(index + 2)}`,
      targetPromptId: index % 9 === 0 ? null : `target-prompt ${getTricky(index + 3)}`,
    }
  })
  const judgmentAssessmentPlan = Array.from({length: 500}, (_value, index) => {
    return {
      action: index % 3 === 0 ? 'reuse' : 'insert',
      conflictCodes: [],
      sourceJudgmentAssessmentId: `source-assessment ${index} ${getTricky(index)}`,
      sourceJudgmentId: `source-judgment ${index} ${getTricky(index)}`,
      targetAssessmentId: index % 3 === 0 ? `target-assessment-${index}` : null,
      targetJudgmentId: index % 4 === 0 ? null : `target-judgment ${getTricky(index + 5)}`,
    }
  })
  const humanReviewPlan = Array.from({length: 300}, (_value, index) => {
    return {
      action: 'insert',
      conflictCodes: [],
      inputSignatureMatches: null,
      kind: ['humanJudgment', 'humanJudgmentSummary', 'review'][index % 3],
      provenanceKind: null,
      sourceId: `source-human ${index} ${getTricky(index)}`,
      targetArticleId: index % 6 === 0 ? null : `target-article ${getTricky(index)}`,
      targetPromptId: index % 3 === 1 ? null : `target-prompt ${getTricky(index + 4)}`,
      uniqueKey: `unique ${index}`,
    }
  })

  return {
    targetPlan: {
      articleMatches,
      articleRoutePlan,
      articleUpdatePlan: [],
      assetPromotionPlan: [],
      duplicateImportMatches: [],
      humanReviewPlan,
      judgmentAssessmentPlan,
      judgmentPlan,
      projectPromptPlan: [],
      projectRoutePlan,
      promptPlan: [],
    },
  } as unknown as ProjectTransferImportPlanArtifact
}

const getPromotion = (articles: readonly ProjectTransferArticlePayloadRecord[]) => {
  const fillFields = ['articleSummary', 'articleAuthors', 'articleVersion', 'sourceMetadata', 'articleCreatedAt', 'doi']

  return {
    articleCreates: articles
      .filter((_article, index) => {
        return index % 2 === 0
      })
      .map((article) => {
        return {article, sourceArticleId: article.sourceArticleId}
      }),
    articleFieldFills: trickyFillValues.map((value, index) => {
      return {
        assetDriven: false,
        assetPaths: [],
        field: fillFields[index % fillFields.length],
        sourceArticleId: `source-article ${getTricky(index)}`,
        targetArticleId: `target-article ${getTricky(index + 1)}`,
        value,
      }
    }),
    manifest: {createdAt: '2026-10-15T00:00:00.000Z', promotions: [], sessionId, updatedAt: '2026-10-15T00:00:00.000Z'},
    promotionPathByPackagePath: {},
  } as unknown as ProjectTransferCommitPromotionResult
}

const createProjectArticleOperationTable = async ({runner, tableName}: {runner: Runner; tableName: string}) => {
  const payloads = trickyStrings.slice(0, 8).map((value, index) => {
    return {sourceArticleId: index === 7 ? ' ' : `source-article ${value}`, sourceProjectArticleId: `pa-${index}`}
  })

  await runner.run(`
    CREATE TEMP TABLE ${tableName} AS
    SELECT row_number() OVER () - 1 AS row_index, json(payload_text) AS payload_json
    FROM UNNEST(${getSqlLiteral(
      payloads.map((payload) => {
        return JSON.stringify(payload)
      }),
    )}::VARCHAR[]) AS payloads(payload_text)
  `)
}

const getCommitTempTablesPath = (cwd: string) => {
  return join(cwd, getProjectTransferImportTempLayout(sessionId).commitTempTablesPath)
}

const getLeftoverCommitTempTableEntries = (cwd: string) => {
  const commitTempTablesPath = getCommitTempTablesPath(cwd)

  return existsSync(commitTempTablesPath) ? readdirSync(commitTempTablesPath) : []
}

test('commit id map NDJSON load matches the legacy VALUES literal row for row', async () => {
  await withRuntimeRoot(async (cwd) => {
    await withRunner(async (runner) => {
      const maps = getCommitIdMaps()
      const legacyTable = 'temp_legacy_commit_id_map'

      await loadLegacyIdMapTable({maps, runner, tableName: legacyTable})
      const tables = await loadProjectTransferCommitIdMapTables({
        fileRoot: {cwd, sessionId},
        maps,
        operationId: 'commit-parity',
        runner,
      })
      const rowCount = await expectTablesIdentical({left: legacyTable, right: tables.idMap, runner})

      expect(rowCount).toBe(getLegacyIdMapRows(maps).length)
      expect(rowCount).toBeGreaterThan(20_000)
      expect(getLeftoverCommitTempTableEntries(cwd)).toEqual([])
    })
  })
})

test('commit id map NDJSON load keeps the empty-table schema and NOT NULL failures', async () => {
  await withRuntimeRoot(async (cwd) => {
    await withRunner(async (runner) => {
      const emptyMaps = {...getEmptyCommitIdMaps(), commitId: 'commit-empty', transferHistoryId: 'history-empty'}
      const legacyTable = 'temp_legacy_empty_commit_id_map'

      await loadLegacyIdMapTable({maps: emptyMaps, runner, tableName: legacyTable})
      const tables = await loadProjectTransferCommitIdMapTables({
        fileRoot: {cwd, sessionId},
        maps: emptyMaps,
        operationId: 'commit-empty',
        runner,
      })

      expect(await expectTablesIdentical({left: legacyTable, right: tables.idMap, runner})).toBe(1)

      const nullTargetMaps = {
        ...emptyMaps,
        articleIdBySourceId: {'source-null': null as unknown as string},
        commitId: 'commit-null-target',
      }
      const error = await loadProjectTransferCommitIdMapTables({
        fileRoot: {cwd, sessionId},
        maps: nullTargetMaps,
        operationId: 'commit-null-target',
        runner,
      }).then(
        () => {
          return null
        },
        (loadError: unknown) => {
          return loadError instanceof Error ? loadError.message : String(loadError)
        },
      )

      expect(error).toContain('NOT NULL constraint failed')
      expect(getLeftoverCommitTempTableEntries(cwd)).toEqual([])
    })
  })
})

test('commit writer NDJSON temp tables match the legacy JSON literal tables row for row', async () => {
  await withRuntimeRoot(async (cwd) => {
    await withRunner(async (runner) => {
      const articles = getArticles()
      const plan = getPlan(articles)
      const promotion = getPromotion(articles)
      const operationTables = getProjectTransferOperationTableNames('temp_table_parity')
      const legacyTables = getCommitWriterTempTables('legacy_parity')
      const files = getCommitWriterTempTableFiles({articles, plan, promotion})

      await createProjectArticleOperationTable({runner, tableName: operationTables.tableNames.projectArticles})
      await loadLegacyWriterTempTables({
        rowsByTable: Object.fromEntries(
          legacyFileTempTables.map((table) => {
            return [table, files[table].rows]
          }),
        ) as Record<LegacyFileTempTable, readonly object[]>,
        runner,
        tables: legacyTables,
      })
      await runner.run(`
        CREATE TEMP TABLE ${legacyTables.projectArticleSources} AS
        SELECT DISTINCT source_article_id
        FROM (
          SELECT json_extract_string(payload_json, '$.sourceArticleId') AS source_article_id
          FROM ${operationTables.tableNames.projectArticles}
          UNION ALL
          SELECT source_article_id
          FROM ${legacyTables.articleRoutePlan}
          WHERE snapshot_project_article_link = TRUE
        ) source_rows
        WHERE source_article_id IS NOT NULL
          AND trim(source_article_id) <> ''
      `)
      const tables = await loadProjectTransferCommitWriterTempTables({
        articles,
        fileRoot: {cwd, sessionId},
        operationTables,
        plan,
        promotion,
        tables: getCommitWriterTempTables(operationTables.operationId),
        tx: runner,
      })
      const rowCountByTable = Object.fromEntries(
        await Promise.all(
          [...legacyFileTempTables, 'projectArticleSources' as const].map(async (table) => {
            return [table, await expectTablesIdentical({left: legacyTables[table], right: tables[table], runner})]
          }),
        ),
      ) as Record<LegacyFileTempTable | 'projectArticleSources', number>

      expect(rowCountByTable).toEqual({
        articleCreates: 6,
        articleFieldFills: trickyFillValues.length,
        articleIdentifiers: files.articleIdentifiers.rows.length,
        articleRoutePlan: trickyStrings.length,
        humanReviewPlan: 300,
        judgmentAssessmentPlan: 500,
        judgmentPlan: 3_000,
        projectArticleSources: rowCountByTable.projectArticleSources,
        projectRoutePlan: 4,
      })
      expect(files.articleIdentifiers.rows.length).toBeGreaterThan(articles.length)
      expect(rowCountByTable.projectArticleSources).toBeGreaterThan(0)
      expect(getLeftoverCommitTempTableEntries(cwd)).toEqual([])

      const [nullFill] = await runner.queryJson<{isSqlNull: boolean; valueJson: string}>(`
        SELECT value_json IS NULL AS isSqlNull, value_json::VARCHAR AS valueJson
        FROM ${tables.articleFieldFills}
        WHERE field = 'articleSummary' AND json_type(value_json) = 'NULL'
      `)

      expect(nullFill).toEqual({isSqlNull: false, valueJson: 'null'})
    })
  })
})

test('commit writer NDJSON temp tables keep empty-table schemas and load values over the default object size', async () => {
  await withRuntimeRoot(async (cwd) => {
    await withRunner(async (runner) => {
      const emptyPlan = getPlan([])
      const plan = {
        ...emptyPlan,
        targetPlan: {
          ...emptyPlan.targetPlan,
          articleRoutePlan: [],
          humanReviewPlan: undefined,
          judgmentAssessmentPlan: [],
          judgmentPlan: undefined,
          projectRoutePlan: [],
        },
      } as unknown as ProjectTransferImportPlanArtifact
      const emptyPromotion = {...getPromotion([]), articleFieldFills: []} as ProjectTransferCommitPromotionResult
      const operationTables = getProjectTransferOperationTableNames('temp_table_empty')
      const legacyTables = getCommitWriterTempTables('legacy_empty')

      await createProjectArticleOperationTable({runner, tableName: operationTables.tableNames.projectArticles})
      await loadLegacyWriterTempTables({
        rowsByTable: Object.fromEntries(
          legacyFileTempTables.map((table) => {
            return [table, [] as readonly object[]]
          }),
        ) as Record<LegacyFileTempTable, readonly object[]>,
        runner,
        tables: legacyTables,
      })
      const tables = await loadProjectTransferCommitWriterTempTables({
        articles: [],
        fileRoot: {cwd, sessionId},
        operationTables,
        plan,
        promotion: emptyPromotion,
        tables: getCommitWriterTempTables(operationTables.operationId),
        tx: runner,
      })
      const schemas = await Promise.all(
        legacyFileTempTables.map(async (table) => {
          const [legacySchema, schema, rows] = await Promise.all([
            getTableSchema(runner, legacyTables[table]),
            getTableSchema(runner, tables[table]),
            getTableRows(runner, tables[table]),
          ])

          expect(schema).toEqual(legacySchema)
          expect(rows).toEqual([])

          return schema.length
        }),
      )

      expect(
        schemas.every((columnCount) => {
          return columnCount > 0
        }),
      ).toBe(true)

      const largeValue = `${'é'.repeat(9_000_000)}"tail"`
      const largeFillTables = await loadProjectTransferCommitWriterTempTables({
        articles: [],
        fileRoot: {cwd, sessionId},
        operationTables,
        plan,
        promotion: {
          ...emptyPromotion,
          articleFieldFills: [
            {field: 'fullText', sourceArticleId: 'source-large', targetArticleId: 'target-large', value: largeValue},
          ],
        } as unknown as ProjectTransferCommitPromotionResult,
        tables: getCommitWriterTempTables('temp_table_large'),
        tx: runner,
      })
      const [largeRow] = await runner.queryJson<{length: number; matches: boolean}>(`
        SELECT
          length(json_extract_string(value_json, '$'))::INTEGER AS length,
          json_extract_string(value_json, '$') = ${getSqlLiteral(largeValue)} AS matches
        FROM ${largeFillTables.articleFieldFills}
      `)

      expect(largeRow).toEqual({length: largeValue.length, matches: true})
      expect(getLeftoverCommitTempTableEntries(cwd)).toEqual([])
    })
  })
})

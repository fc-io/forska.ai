import {rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {afterAll, beforeAll, expect, test} from 'bun:test'

import type {AppDatabaseAppendMetrics, AppendResult, JudgmentInsertRow} from './appDatabaseService.ts'

const tempDbPath = `/tmp/f1-app-database-append-judgments-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let appendJudgments: ((rows: JudgmentInsertRow[]) => Promise<AppendResult>) | null = null
let closeDatabase: (() => Promise<void>) | null = null
let getAppendMetrics: (() => AppDatabaseAppendMetrics) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  appendJudgments = (rows: JudgmentInsertRow[]) => {
    return database.appendJudgments(rows)
  }
  closeDatabase = () => {
    return database.close()
  }
  getAppendMetrics = () => {
    return database.getAppendMetrics()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('appendJudgments uses append lanes and preserves dedupe semantics', async () => {
  if (!appendJudgments || !getAppendMetrics || !queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const currentRunDatabase = runDatabase
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const promptId = `prompt-${Date.now()}`
  const articleIds = ['article-a', 'article-b', 'article-c', 'article-d'].map((value) => {
    return `${value}-${Date.now()}`
  })
  const createdAt = new Date()
  const updatedAt = new Date(createdAt.getTime() + 1_000)

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await Promise.all(
    articleIds.map((articleId) => {
      return currentRunDatabase(`
        INSERT INTO app.article (id, article_title)
        VALUES ('${articleId}', '${articleId}')
      `)
    }),
  )

  const buildRow = (params: {articleId: string; id: string}): JudgmentInsertRow => {
    return {
      answeredOriginal: 'yes',
      answeredOriginalAsArray: ['yes'],
      articleId: params.articleId,
      chunkingStrategy: null,
      confidenceOriginal: 50,
      createdAt,
      explanation: 'because',
      id: params.id,
      isAnswered: true,
      modelId,
      projectId: null,
      promptId,
      quotes: ['quote'],
      snapshotProjectId: null,
      snapshotProjectModelName: null,
      updatedAt,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }
  }

  const firstBatch = [
    buildRow({articleId: articleIds[0] ?? '', id: `judgment-a-${Date.now()}`}),
    buildRow({articleId: articleIds[1] ?? '', id: `judgment-b-${Date.now()}`}),
  ]
  const secondBatch = [
    buildRow({articleId: articleIds[2] ?? '', id: `judgment-c-${Date.now()}`}),
    buildRow({articleId: articleIds[3] ?? '', id: `judgment-d-${Date.now()}`}),
  ]
  const parallelResults = await Promise.all([appendJudgments(firstBatch), appendJudgments(secondBatch)])
  const parallelTotals = parallelResults.reduce(
    (state, result) => {
      return {
        attempted: state.attempted + result.attempted,
        inserted: state.inserted + result.inserted,
        skipped: state.skipped + result.skipped,
      }
    },
    {attempted: 0, inserted: 0, skipped: 0},
  )
  const duplicateResult = await appendJudgments([
    buildRow({articleId: articleIds[0] ?? '', id: `judgment-a-duplicate-${Date.now()}`}),
  ])
  const appendMetrics = getAppendMetrics()
  const [countRow] = await queryDatabase<{total: number}>(
    `SELECT COUNT(*) AS total FROM app.judgment WHERE model_id = '${modelId}'`,
  )

  expect(parallelTotals).toEqual({attempted: 4, inserted: 4, skipped: 0})
  expect(duplicateResult).toEqual({attempted: 1, inserted: 0, skipped: 1})
  expect(appendMetrics.laneCount).toBe(2)
  expect(appendMetrics.maxQueueDepth).toBeGreaterThanOrEqual(1)
  expect(appendMetrics.rowsAttempted).toBe(5)
  expect(appendMetrics.rowsInserted).toBe(4)
  expect(appendMetrics.rowsSkipped).toBe(1)
  expect(appendMetrics.averageRowsPerSecondAttempted).not.toBeNull()
  expect(appendMetrics.queueDepth).toBe(0)
  expect(Number(countRow?.total ?? 0)).toBe(4)
})

test('appendJudgments safely inserts quote-heavy judgment text', async () => {
  if (!appendJudgments || !queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const connectionId = `connection-quotes-${Date.now()}`
  const modelId = `model-quotes-${Date.now()}`
  const promptId = `prompt-quotes-${Date.now()}`
  const articleId = `article-quotes-${Date.now()}`
  const answeredOriginal = `'"CONCLUSIONS: ... Every unit needs a rational antibiotic policy."'`
  const explanation =
    `Results for febrile neutropenia over a period of 1-year are presented."', `
    + `'"CONCLUSIONS: ... Every unit needs a rational antibiotic policy..."; unit's local path \\ward`
  const createdAt = new Date()
  const updatedAt = new Date(createdAt.getTime() + 1_000)
  const rowId = `judgment-quotes-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  const result = await appendJudgments([
    {
      answeredOriginal,
      answeredOriginalAsArray: [answeredOriginal, explanation],
      articleId,
      chunkingStrategy: null,
      confidenceOriginal: 50,
      createdAt,
      explanation,
      id: rowId,
      isAnswered: true,
      modelId,
      projectId: null,
      promptId,
      quotes: [answeredOriginal, explanation],
      snapshotProjectId: null,
      snapshotProjectModelName: null,
      updatedAt,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    },
  ])
  const [insertedRow] = await queryDatabase<{answeredOriginal: string | null; explanation: string | null}>(`
    SELECT answered_original AS answeredOriginal, explanation
    FROM app.judgment
    WHERE id = '${rowId}'
  `)

  expect(result).toEqual({attempted: 1, inserted: 1, skipped: 0})
  expect(insertedRow?.answeredOriginal).toBe(answeredOriginal)
  expect(insertedRow?.explanation).toBe(explanation)
})

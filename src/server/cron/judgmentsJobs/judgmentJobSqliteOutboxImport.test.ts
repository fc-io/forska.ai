import {rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {afterAll, beforeAll, expect, test} from 'bun:test'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'

const tempDbPath = `/tmp/f1-judgment-job-sqlite-import-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let importOutboxBatch: (() => Promise<number>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null
let storeSinglePromptJudgment:
  | (typeof import('../../../agent/judge/storeSinglePromptJudgment.ts'))['storeSinglePromptJudgment']
  | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
    importModule,
    storeModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentJobSqliteOutboxImport.ts'),
    import('../../../agent/judge/storeSinglePromptJudgment.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
  importOutboxBatch = () => {
    return importModule.importJudgmentJobSqliteOutboxBatch()
  }
  storeSinglePromptJudgment = storeModule.storeSinglePromptJudgment
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('imports SQLite-backed judgments into DuckDB in batches', async () => {
  if (!runDatabase || !queryDatabase || !sqliteService || !importOutboxBatch || !storeSinglePromptJudgment) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`
  const promptId = `prompt-${Date.now()}`
  const articleId = `article-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'SQLite Import Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimed] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimed) {
    throw new Error('Failed to claim SQLite queue prompt')
  }

  await storeSinglePromptJudgment({
    article: {id: articleId} as ArticleRecord,
    judgmentsJobId: jobId,
    promptId,
    queueRecordId: claimed.recordId,
    modelId,
    projectId,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['quote']},
    chunkingStrategy: null,
  })

  expect((await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(1)
  expect(await importOutboxBatch()).toBe(1)

  const rows = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${articleId}'
      AND prompt_id = '${promptId}'
      AND model_id = '${modelId}'
  `)

  expect(rows).toHaveLength(1)
  expect((await service.getPendingOutboxBatch({maxBytes: 1024 * 1024, maxRows: 10})).length).toBe(0)
})

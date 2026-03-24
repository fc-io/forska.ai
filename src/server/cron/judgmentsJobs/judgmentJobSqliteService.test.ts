import {rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {afterAll, beforeAll, expect, test} from 'bun:test'

const tempDbPath = `/tmp/f1-judgment-job-sqlite-service-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, sqliteModule] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('./judgmentJobSqliteService.ts'),
  ])

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteService = sqliteModule.getJudgmentJobSqliteService
})

afterAll(async () => {
  await sqliteService?.().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('claims and requeues prompts from the per-job SQLite queue', async () => {
  if (!runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`

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
    VALUES ('${projectId}', 'SQLite Queue Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-1', promptId: 'prompt-1'},
      {articleId: 'article-2', promptId: 'prompt-2'},
    ],
    'server-a',
  )

  expect(await service.getReadyCount(jobId)).toBe(2)

  const claimed = await service.claimReadyPrompts(jobId, 'server-a', 1)

  expect(claimed).toHaveLength(1)
  expect(await service.getReadyCount(jobId)).toBe(1)
  expect(await service.getInFlightCount(jobId)).toBe(1)

  const requeued = await service.requeueAbandonedSentPrompts({
    jobId,
    serverJobId: 'server-b',
    staleBefore: new Date(Date.now() + 1000),
  })

  expect(requeued).toBe(1)
  expect(await service.getReadyCount(jobId)).toBe(2)
  expect(await service.getInFlightCount(jobId)).toBe(0)
})

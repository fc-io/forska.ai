import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, test} from 'bun:test'

import {getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'

const tempDbPath = `/tmp/f1-judgments-jobs-cleanup-stale-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let judgmentsJobsCleanupStale: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteService: Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService'] | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
    cleanupModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentsJobsCleanupStale.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  judgmentsJobsCleanupStale = cleanupModule.judgmentsJobsCleanupStale
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
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
  rmSync(`${tempDbPath}.duckdb-owner.history.json`, {force: true})
  rmSync(`${tempDbPath}.duckdb-owner.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('cleanupStale automatically repairs recoverable orphaned judged queue rows for draining jobs', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `cleanup-stale-orphan-connection-${Date.now()}`
  const modelId = `cleanup-stale-orphan-model-${Date.now()}`
  const projectId = `cleanup-stale-orphan-project-${Date.now()}`
  const jobId = `cleanup-stale-orphan-job-${Date.now()}`
  const articleId = `cleanup-stale-orphan-article-${Date.now()}`
  const promptId = `cleanup-stale-orphan-prompt-${Date.now()}`

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
    VALUES ('${projectId}', 'Cleanup stale orphan repair test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${articleId}',
      'external-${articleId}',
      'Cleanup stale orphan article',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
      TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
    )
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Cleanup stale orphan prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for cleanup stale orphan repair test')
  }

  await service.markPromptAsJudged(jobId, claimedPrompt.recordId)

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `),
  ).toEqual([{status: 'paused', storageState: 'draining'}])
  expect((await service.getHealthSnapshot(jobId)).orphanedJudgedRowCount).toBe(1)

  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
    SELECT status, storage_state AS storageState
    FROM app.judgment_job
    WHERE id = '${jobId}'
  `),
  ).toEqual([{status: 'paused', storageState: 'active'}])
  expect(await service.getHealthSnapshot(jobId)).toMatchObject({
    orphanedJudgedRowCount: 0,
    outboxRowCount: 0,
    promptCounts: {claimed: 0, judged: 0, ready: 1, running: 0, skipped: 0},
    retainedRowCount: 1,
  })
})

test('cleanupStale clears stale running prompts before finalizing draining jobs', async () => {
  if (!judgmentsJobsCleanupStale || !queryDatabase || !runDatabase || !sqliteService) {
    throw new Error('Test database not initialized')
  }

  const service = sqliteService()
  const connectionId = `cleanup-stale-running-connection-${Date.now()}`
  const modelId = `cleanup-stale-running-model-${Date.now()}`
  const projectId = `cleanup-stale-running-project-${Date.now()}`
  const jobId = `cleanup-stale-running-job-${Date.now()}`
  const sqlitePath = getJudgmentJobSqlitePath(jobId)

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
    VALUES ('${projectId}', 'Cleanup stale running drain test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'paused', 'draining')
  `)

  await service.initializeJob(jobId)
  await service.addReadyPrompts(
    jobId,
    [{articleId: 'article-stale-running', promptId: 'prompt-stale-running'}],
    'server-a',
  )

  const [claimedPrompt] = await service.claimReadyPrompts(jobId, 'server-a', 1)

  if (!claimedPrompt) {
    throw new Error('Failed to claim SQLite queue prompt for cleanup stale running test')
  }

  await service.markPromptAsRunning(jobId, claimedPrompt.recordId)
  const sqliteDatabase = new Database(sqlitePath)

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET sent_at = ?
          WHERE id = ?
        `,
      )
      .run('2026-04-01T00:00:00.000Z', claimedPrompt.recordId)
  } finally {
    sqliteDatabase.close()
  }

  expect((await service.getHealthSnapshot(jobId)).promptCounts).toEqual({
    claimed: 0,
    judged: 0,
    ready: 0,
    running: 1,
    skipped: 0,
  })
  expect(existsSync(sqlitePath)).toBe(true)

  await judgmentsJobsCleanupStale()

  expect(
    await queryDatabase<{status: string; storageState: string}>(`
      SELECT status, storage_state AS storageState
      FROM app.judgment_job
      WHERE id = '${jobId}'
    `),
  ).toEqual([{status: 'paused', storageState: 'drained'}])
  expect(existsSync(sqlitePath)).toBe(false)
})

import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, test} from 'bun:test'
import {rmSync} from 'fs'
import {dirname, join} from 'path'

const tempDbPath = `/tmp/f1-requeue-abandoned-prompts-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let requeueAbandonedSentPrompts: ((input: {jobIds: string[]; serverJobId: string}) => Promise<number>) | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    requeueModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./requeueAbandonedSentPrompts.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  requeueAbandonedSentPrompts = requeueModule.requeueAbandonedSentPrompts
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('requeues sent SQLite prompts claimed by an older server job', async () => {
  if (!runDatabase || !requeueAbandonedSentPrompts) {
    throw new Error('Test database not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const jobId = `job-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const connectionId = `connection-${Date.now()}`
  const oldServerJobId = 'server-job-old-host-3004-111'
  const currentServerJobId = 'server-job-new-host-3004-222'

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('${projectId}', 'Requeue Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: `article-stale-${Date.now()}`, promptId: `prompt-stale-${Date.now()}`},
      {articleId: `article-current-${Date.now()}`, promptId: `prompt-current-${Date.now()}`},
    ],
    'server-job-queued',
  )

  const [stalePrompt, currentPrompt] = await sqliteService.claimReadyPrompts(jobId, oldServerJobId, 2)

  if (!stalePrompt || !currentPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for requeue test')
  }

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET status = 'claimed',
              sent_at = CASE
                  WHEN id = ? THEN ?
                  ELSE sent_at
                END,
              updated_at = CASE
                  WHEN id = ? THEN ?
                  ELSE updated_at
                END,
              server_id = CASE
                  WHEN id = ? THEN ?
                  ELSE ?
                END
          WHERE id IN (?, ?)
        `,
      )
      .run(
        stalePrompt.recordId,
        new Date(Date.now() - 45_000).toISOString(),
        stalePrompt.recordId,
        new Date(Date.now() - 45_000).toISOString(),
        currentPrompt.recordId,
        currentServerJobId,
        oldServerJobId,
        stalePrompt.recordId,
        currentPrompt.recordId,
      )
  } finally {
    sqliteDatabase.close()
  }

  const requeued = await requeueAbandonedSentPrompts({jobIds: [jobId], serverJobId: currentServerJobId})

  expect(requeued).toBe(1)
  expect(await sqliteService.getReadyCount(jobId)).toBe(1)
  expect(await sqliteService.getInFlightCount(jobId)).toBe(1)
  await sqliteService.closeAll()
})

test('keeps older ready rows ahead of newer inserts and preserves stale sent queue position after requeue', async () => {
  if (!runDatabase || !requeueAbandonedSentPrompts) {
    throw new Error('Test database not initialized')
  }

  const {getJudgmentJobSqlitePath} = await import('./judgmentJobPaths.ts')
  const {getJudgmentJobSqliteService} = await import('./judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const jobId = `job-order-${Date.now()}`
  const projectId = `project-order-${Date.now()}`
  const modelId = `model-order-${Date.now()}`
  const connectionId = `connection-order-${Date.now()}`
  const oldServerJobId = 'server-job-old-host-3004-333'
  const currentServerJobId = 'server-job-new-host-3004-444'

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('${projectId}', 'Requeue Ordering Test', '${modelId}')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: 'article-stale-first', promptId: 'prompt-stale-first'},
      {articleId: 'article-ready-middle', promptId: 'prompt-ready-middle'},
    ],
    'server-job-queued',
  )

  const [stalePrompt] = await sqliteService.claimReadyPrompts(jobId, oldServerJobId, 1)

  if (!stalePrompt) {
    throw new Error('Failed to claim stale SQLite queue prompt for requeue order test')
  }

  await sqliteService.addReadyPrompts(
    jobId,
    [{articleId: 'article-human-newest', promptId: 'prompt-human-newest'}],
    'server-job-queued',
  )

  const sqliteDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  try {
    sqliteDatabase
      .query(
        `
          UPDATE queue_prompt
          SET status = 'claimed', sent_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        new Date(Date.now() - 45_000).toISOString(),
        new Date(Date.now() - 45_000).toISOString(),
        stalePrompt.recordId,
      )
  } finally {
    sqliteDatabase.close()
  }

  expect(await requeueAbandonedSentPrompts({jobIds: [jobId], serverJobId: currentServerJobId})).toBe(1)
  expect(
    (await sqliteService.claimReadyPrompts(jobId, currentServerJobId, 3)).map((prompt) => {
      return prompt.articleId
    }),
  ).toEqual(['article-stale-first', 'article-ready-middle', 'article-human-newest'])
  await sqliteService.closeAll()
})

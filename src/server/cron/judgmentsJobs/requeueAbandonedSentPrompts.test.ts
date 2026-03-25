import {afterAll, beforeAll, expect, test} from 'bun:test'
import {rmSync} from 'fs'

const tempDbPath = `/tmp/f1-requeue-abandoned-prompts-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
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
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  requeueAbandonedSentPrompts = requeueModule.requeueAbandonedSentPrompts
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
})

test('requeues sent prompts claimed by an older server job', async () => {
  if (!queryDatabase || !runDatabase || !requeueAbandonedSentPrompts) {
    throw new Error('Test database not initialized')
  }

  const jobId = `job-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const connectionId = `connection-${Date.now()}`
  const promptId = `prompt-${Date.now()}`
  const currentPromptId = `prompt-current-${Date.now()}`
  const articleId = `article-${Date.now()}`
  const currentArticleId = `article-current-${Date.now()}`
  const staleQueueId = `queue-stale-${Date.now()}`
  const currentQueueId = `queue-current-${Date.now()}`
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
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES
      ('${promptId}', 'Prompt', '${promptId}-hash'),
      ('${currentPromptId}', 'Prompt current', '${currentPromptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES
      ('${articleId}', 'Article'),
      ('${currentArticleId}', 'Article current')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job_prompt (id, job_id, article_id, prompt_id, status, server_id, sent_at)
    VALUES
      ('${staleQueueId}', '${jobId}', '${articleId}', '${promptId}', 'sent', '${oldServerJobId}', current_timestamp - INTERVAL '45 seconds'),
      ('${currentQueueId}', '${jobId}', '${currentArticleId}', '${currentPromptId}', 'sent', '${currentServerJobId}', current_timestamp)
  `)

  const requeued = await requeueAbandonedSentPrompts({jobIds: [jobId], serverJobId: currentServerJobId})

  expect(requeued).toBe(1)

  const rows = await queryDatabase<{id: string; sentAt: string | null; status: string}>(`
    SELECT id, status, sent_at AS sentAt
    FROM app.judgment_job_prompt
    WHERE id IN ('${staleQueueId}', '${currentQueueId}')
    ORDER BY id ASC
  `)

  const staleRow = rows.find((row) => {
    return row.id === staleQueueId
  })
  const currentRow = rows.find((row) => {
    return row.id === currentQueueId
  })

  expect(staleRow?.status).toBe('ready')
  expect(staleRow?.sentAt ?? null).toBe(null)
  expect(currentRow?.status).toBe('sent')
  expect(currentRow?.sentAt ?? null).not.toBe(null)
})

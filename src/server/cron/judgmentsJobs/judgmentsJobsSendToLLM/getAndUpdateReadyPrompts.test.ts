import {afterAll, beforeAll, expect, test} from 'bun:test'
import {rmSync} from 'fs'

const tempDbPath = `/tmp/f1-get-and-update-ready-prompts-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let getAndUpdateReadyPrompts:
  | ((serverJobId: string, jobId: string, limit: number) => Promise<Array<{articleId: string; recordId: string}>>)
  | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    readyPromptsModule,
  ] = await Promise.all([
    import('../../../../db/migrateDuckdb.ts'),
    import('../../../services/appDatabaseService.ts'),
    import('../../../utils/duckdbService.ts'),
    import('../../../utils/serverRuntimeRole.ts'),
    import('./getAndUpdateReadyPrompts.ts'),
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
  getAndUpdateReadyPrompts = readyPromptsModule.getAndUpdateReadyPrompts
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
})

test('marks stale ready rows judged and claims fresh rows', async () => {
  if (!getAndUpdateReadyPrompts || !queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`
  const freshArticleId = `article-fresh-${Date.now()}`
  const staleArticleId = `article-stale-${Date.now()}`
  const freshPromptId = `prompt-fresh-${Date.now()}`
  const stalePromptId = `prompt-stale-${Date.now()}`
  const freshQueueId = `queue-fresh-${Date.now()}`
  const staleQueueId = `queue-stale-${Date.now()}`
  const staleJudgmentId = `judgment-stale-${Date.now()}`

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
    VALUES ('${projectId}', 'Ready Prompt Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES
      ('${freshPromptId}', 'Fresh prompt', '${freshPromptId}-hash'),
      ('${stalePromptId}', 'Stale prompt', '${stalePromptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES
      ('${freshArticleId}', 'Fresh article'),
      ('${staleArticleId}', 'Stale article')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job_prompt (id, job_id, article_id, prompt_id, status)
    VALUES
      ('${freshQueueId}', '${jobId}', '${freshArticleId}', '${freshPromptId}', 'ready'),
      ('${staleQueueId}', '${jobId}', '${staleArticleId}', '${stalePromptId}', 'ready')
  `)
  await runDatabase(`
    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      is_answered
    )
    VALUES (
      '${staleJudgmentId}',
      '${staleArticleId}',
      '${stalePromptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      TRUE,
      FALSE,
      FALSE,
      TRUE
    )
  `)

  const prompts = await getAndUpdateReadyPrompts('server-job', jobId, 2)

  expect(prompts.length).toBe(1)
  expect(prompts[0]?.recordId).toBe(freshQueueId)
  expect(prompts[0]?.articleId).toBe(freshArticleId)

  const queueRows = await queryDatabase<{id: string; judgedAt: string | null; sentAt: string | null; status: string}>(`
    SELECT id, status, judged_at AS judgedAt, sent_at AS sentAt
    FROM app.judgment_job_prompt
    WHERE job_id = '${jobId}'
    ORDER BY id ASC
  `)

  const freshRow = queueRows.find((row) => {
    return row.id === freshQueueId
  })
  const staleRow = queueRows.find((row) => {
    return row.id === staleQueueId
  })

  expect(freshRow?.status).toBe('sent')
  expect(freshRow?.sentAt ?? null).not.toBe(null)
  expect(staleRow?.status).toBe('judged')
  expect(staleRow?.judgedAt ?? null).not.toBe(null)
})

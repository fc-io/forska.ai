import {afterAll, beforeAll, expect, test} from 'bun:test'
import {rmSync} from 'fs'
import {dirname, join} from 'path'

const tempDbPath = `/tmp/f1-get-and-update-ready-prompts-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let getAndUpdateReadyPrompts:
  | ((
      serverJobId: string,
      jobId: string,
      limit: number,
      requestRuntime: {
        providerConnectionId: string | null
        providerMaxInflightRequests: number | null
        providerUsesFamilyDefault: boolean
      },
    ) => Promise<
      Array<{
        articleId: string
        modelBaseUrl: string
        modelId: string
        providerConnectionId: string | null
        providerMaxInflightRequests: number | null
        providerUsesFamilyDefault: boolean
        projectId: string
        promptId: string
        recordId: string
      }>
    >)
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
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  getAndUpdateReadyPrompts = readyPromptsModule.getAndUpdateReadyPrompts
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('../judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

test('claims ready rows from the per-job SQLite queue', async () => {
  if (!getAndUpdateReadyPrompts || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`
  const firstArticleId = `article-first-${Date.now()}`
  const secondArticleId = `article-second-${Date.now()}`
  const firstPromptId = `prompt-first-${Date.now()}`
  const secondPromptId = `prompt-second-${Date.now()}`

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
    VALUES (
      '${connectionId}',
      'sglang',
      'SGLang',
      TRUE,
      'none',
      'http://localhost:30001/v1',
      '{"manualWorkerUrls":[],"workerUrlMode":"manual"}'
    )
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

  await sqliteService.initializeJob(jobId)
  await sqliteService.releaseOwnedLease(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: firstArticleId, promptId: firstPromptId},
      {articleId: secondArticleId, promptId: secondPromptId},
    ],
    'server-job-queued',
  )
  await sqliteService.releaseOwnedLease(jobId)

  const prompts = await getAndUpdateReadyPrompts('server-job-claim', jobId, 2, {
    providerConnectionId: connectionId,
    providerMaxInflightRequests: 3,
    providerUsesFamilyDefault: false,
  })

  expect(prompts).toHaveLength(2)
  expect(
    prompts.map((prompt) => {
      return {articleId: prompt.articleId, promptId: prompt.promptId}
    }),
  ).toEqual([
    {articleId: firstArticleId, promptId: firstPromptId},
    {articleId: secondArticleId, promptId: secondPromptId},
  ])
  expect(
    prompts.every((prompt) => {
      return (
        prompt.modelId === modelId
        && prompt.projectId === projectId
        && prompt.modelBaseUrl === 'http://localhost:30001/v1'
        && prompt.providerConnectionId === connectionId
        && prompt.providerMaxInflightRequests === 3
        && prompt.providerUsesFamilyDefault === false
      )
    }),
  ).toBe(true)
  expect(await sqliteService.getInFlightCount(jobId)).toBe(2)
  expect(await sqliteService.getReadyCount(jobId)).toBe(0)
  await sqliteService.closeAll()
})

import {afterAll, afterEach, beforeAll, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'
import {rmSync} from 'fs'
import {dirname, join} from 'path'

import {HttpError} from '../utils/httpError.ts'

const tempDbPath = `/tmp/f1-judgments-jobs-routes-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url)
  .pathname

const state = {
  assertStoredProviderModelRuntimeMatch: mock(async (_input: {modelId: string}) => {}),
  getStoredProviderModelRuntimeMatch: mock(async (_input: {modelId: string}) => {
    return {message: null, ok: true, reason: null}
  }),
}

void mock.module(providerRuntimeModelGuardModulePath, () => {
  return {
    assertStoredProviderModelRuntimeMatch: state.assertStoredProviderModelRuntimeMatch,
    getStoredProviderModelRuntimeMatch: state.getStoredProviderModelRuntimeMatch,
  }
})

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {judgmentsJobsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./JudgmentsJobsRoutes.ts'),
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
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

afterEach(() => {
  state.assertStoredProviderModelRuntimeMatch.mockImplementation(async (_input: {modelId: string}) => {})
  state.getStoredProviderModelRuntimeMatch.mockImplementation(async (_input: {modelId: string}) => {
    return {message: null, ok: true, reason: null}
  })
})

const insertProjectFixture = async ({
  connectionId,
  modelId,
  projectId,
}: {
  connectionId: string
  modelId: string
  projectId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('${projectId}', 'Runtime Match Project', '${modelId}')
  `)
}

const insertQueuedPromptFixture = async ({
  articleId,
  jobId,
  promptId,
}: {
  articleId: string
  jobId: string
  promptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(jobId, [{articleId, promptId}], 'server-a')
}

test('creating a judgments job fails when the runtime model check fails', async () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const projectId = `runtime-mismatch-project-${Date.now()}`
  const modelId = `runtime-mismatch-model-${Date.now()}`
  const connectionId = `runtime-mismatch-connection-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  state.assertStoredProviderModelRuntimeMatch.mockImplementationOnce(async () => {
    throw new HttpError(400, 'Project model Qwen/Qwen3.5-122B-A10B does not match the active SGLang runtime.')
  })

  const response = await app.handle(
    new Request('http://localhost/api/judgmentsjobs', {
      body: JSON.stringify({projectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).toContain('does not match the active SGLang runtime')
})

test('starting an existing judgments job fails when the runtime model check fails', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `runtime-restart-project-${Date.now()}`
  const modelId = `runtime-restart-model-${Date.now()}`
  const connectionId = `runtime-restart-connection-${Date.now()}`
  const jobId = `runtime-restart-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)
  state.assertStoredProviderModelRuntimeMatch.mockImplementationOnce(async () => {
    throw new HttpError(400, 'Project model Qwen/Qwen3.5-122B-A10B does not match the active SGLang runtime.')
  })

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'running'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).toContain('does not match the active SGLang runtime')
})

test('pausing an existing judgments job succeeds when queued prompts reference the job', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `pause-project-${Date.now()}`
  const modelId = `pause-model-${Date.now()}`
  const connectionId = `pause-connection-${Date.now()}`
  const jobId = `pause-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)
  await insertQueuedPromptFixture({
    articleId: `pause-article-${Date.now()}`,
    jobId,
    promptId: `pause-prompt-${Date.now()}`,
  })

  const response = await app.handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'paused'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain('paused')
})

test('judgment job routes expose storage health fields', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `storage-fields-project-${Date.now()}`
  const modelId = `storage-fields-model-${Date.now()}`
  const connectionId = `storage-fields-connection-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})

  const createResponse = await app.handle(
    new Request('http://localhost/api/judgmentsjobs', {
      body: JSON.stringify({projectId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createBody = (await createResponse.json()) as {
    data: {
      jobId: string
      storageState: string
      quarantinedAt: string | null
      quarantineReason: string | null
      lastImportStartedAt: string | null
      lastImportCompletedAt: string | null
      lastImportErrorAt: string | null
      lastImportError: string | null
      lastImportExitCode: number | null
      importFailureCount: number
      pauseRequestedAt: string | null
    }
  }

  expect(createResponse.status).toBe(200)
  expect(createBody.data.storageState).toBe('active')
  expect(createBody.data.quarantinedAt).toBeNull()
  expect(createBody.data.quarantineReason).toBeNull()
  expect(createBody.data.lastImportStartedAt).toBeNull()
  expect(createBody.data.lastImportCompletedAt).toBeNull()
  expect(createBody.data.lastImportErrorAt).toBeNull()
  expect(createBody.data.lastImportError).toBeNull()
  expect(createBody.data.lastImportExitCode).toBeNull()
  expect(createBody.data.importFailureCount).toBe(0)
  expect(createBody.data.pauseRequestedAt).toBeNull()

  const detailsResponse = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${createBody.data.jobId}`))
  const detailsBody = (await detailsResponse.json()) as {
    storageState: string
    quarantinedAt: string | null
    quarantineReason: string | null
    lastImportStartedAt: string | null
    lastImportCompletedAt: string | null
    lastImportErrorAt: string | null
    lastImportError: string | null
    lastImportExitCode: number | null
    importFailureCount: number
    pauseRequestedAt: string | null
  }

  expect(detailsResponse.status).toBe(200)
  expect(detailsBody.storageState).toBe('active')
  expect(detailsBody.importFailureCount).toBe(0)
  expect(detailsBody.pauseRequestedAt).toBeNull()

  const listResponse = await app.handle(new Request('http://localhost/api/judgmentsjobs'))
  const listBody = (await listResponse.json()) as {
    data: Array<{
      id: string
      storageState: string
      quarantinedAt: string | null
      quarantineReason: string | null
      lastImportStartedAt: string | null
      lastImportCompletedAt: string | null
      lastImportErrorAt: string | null
      lastImportError: string | null
      lastImportExitCode: number | null
      importFailureCount: number
      pauseRequestedAt: string | null
    }>
  }

  const listedJob = listBody.data.find((job) => {
    return job.id === createBody.data.jobId
  })

  expect(listResponse.status).toBe(200)
  expect(listedJob?.storageState).toBe('active')
  expect(listedJob?.importFailureCount).toBe(0)
  expect(listedJob?.pauseRequestedAt).toBeNull()
})

test('reads SQLite-backed skipped prompt stats separately from judged prompts', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const projectId = `sqlite-stats-project-${Date.now()}`
  const modelId = `sqlite-stats-model-${Date.now()}`
  const connectionId = `sqlite-stats-connection-${Date.now()}`
  const jobId = `sqlite-stats-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [
      {articleId: `sqlite-stats-article-ready-${Date.now()}`, promptId: `sqlite-stats-prompt-ready-${Date.now()}`},
      {articleId: `sqlite-stats-article-judged-${Date.now()}`, promptId: `sqlite-stats-prompt-judged-${Date.now()}`},
      {articleId: `sqlite-stats-article-skipped-${Date.now()}`, promptId: `sqlite-stats-prompt-skipped-${Date.now()}`},
      {articleId: `sqlite-stats-article-sent-${Date.now()}`, promptId: `sqlite-stats-prompt-sent-${Date.now()}`},
    ],
    'server-a',
  )

  const [judgedPrompt, skippedPrompt, sentPrompt] = await sqliteService.claimReadyPrompts(jobId, 'server-a', 3)

  if (!judgedPrompt || !skippedPrompt || !sentPrompt) {
    throw new Error('Failed to claim SQLite queue prompts for stats test')
  }

  await sqliteService.recordJudgmentSuccess(jobId, {
    answeredOriginal: 'yes',
    answeredOriginalAsArray: ['yes'],
    articleId: judgedPrompt.articleId,
    chunkingStrategy: null,
    confidenceOriginal: 50,
    createdAt: new Date(),
    explanation: 'because',
    isAnswered: true,
    judgmentId: `sqlite-stats-judgment-${Date.now()}`,
    modelId,
    projectId,
    promptId: judgedPrompt.promptId,
    queuePromptId: judgedPrompt.recordId,
    quotes: ['quote'],
    rawResponseJson: {answer: 'yes'},
    snapshotProjectId: projectId,
    snapshotProjectModelName: 'Qwen 122B',
    updatedAt: new Date(),
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  })
  await sqliteService.markPromptAsSkipped(jobId, skippedPrompt.recordId, 'no_fulltext')

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    promptStats: {judged: number; ready: number; sent: number; skipped: number}
    storageHealth: {
      claimedOutboxCount: number
      lastAckSeq: number | null
      oldestUnexportedAgeMs: number | null
      outboxRowCount: number
      promptCounts: {judged: number; ready: number; sent: number; skipped: number}
      retainedRowCount: number
      sqliteFileBytes: number | null
      walBytes: number
    }
  }

  expect(response.status).toBe(200)
  expect(body.promptStats).toEqual({judged: 1, ready: 1, sent: 1, skipped: 1})
  expect(body.storageHealth.promptCounts).toEqual(body.promptStats)
  expect(body.storageHealth.outboxRowCount).toBe(1)
  expect(body.storageHealth.retainedRowCount).toBe(4)
  expect(body.storageHealth.sqliteFileBytes).not.toBeNull()
  expect(body.storageHealth.oldestUnexportedAgeMs).toBeGreaterThanOrEqual(0)
})

test('returns safe SQLite health values for jobs without a local sqlite db', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `sqlite-health-missing-project-${Date.now()}`
  const modelId = `sqlite-health-missing-model-${Date.now()}`
  const connectionId = `sqlite-health-missing-connection-${Date.now()}`
  const jobId = `sqlite-health-missing-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
  const body = (await response.json()) as {
    promptStats: {judged: number; ready: number; sent: number; skipped: number}
    storageHealth: {
      claimedOutboxCount: number
      lastAckSeq: number | null
      oldestUnexportedAgeMs: number | null
      outboxRowCount: number
      promptCounts: {judged: number; ready: number; sent: number; skipped: number}
      retainedRowCount: number
      sqliteFileBytes: number | null
      walBytes: number
    }
  }

  expect(response.status).toBe(200)
  expect(body.promptStats).toEqual({judged: 0, ready: 0, sent: 0, skipped: 0})
  expect(body.storageHealth).toEqual({
    claimedOutboxCount: 0,
    lastAckSeq: null,
    oldestUnexportedAgeMs: null,
    outboxRowCount: 0,
    promptCounts: {judged: 0, ready: 0, sent: 0, skipped: 0},
    retainedRowCount: 0,
    sqliteFileBytes: null,
    walBytes: 0,
  })
})

test('deleting an existing judgments job succeeds when prompts and token usage reference the job', async () => {
  if (!app || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  const projectId = `delete-project-${Date.now()}`
  const modelId = `delete-model-${Date.now()}`
  const connectionId = `delete-connection-${Date.now()}`
  const jobId = `delete-job-${Date.now()}`

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'paused')
  `)
  await insertQueuedPromptFixture({
    articleId: `delete-article-${Date.now()}`,
    jobId,
    promptId: `delete-prompt-${Date.now()}`,
  })
  await runDatabase(`
    INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
    VALUES ('delete-token-${Date.now()}', '${jobId}', 1, 10, 5, 15)
  `)

  const response = await app.handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {method: 'DELETE'}))
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain(jobId)
})

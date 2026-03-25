import {afterAll, afterEach, beforeAll, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'
import {rmSync} from 'fs'

import {HttpError} from '../utils/httpError.ts'

const tempDbPath = `/tmp/f1-judgments-jobs-routes-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url)
  .pathname

const state = {
  assertStoredProviderModelRuntimeMatch: mock(async (_input: {modelId: string}) => {}),
  getStoredProviderModelRuntimeMatch: mock(async (_input: {modelId: string}) => {
    return {message: null, ok: true}
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
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

afterEach(() => {
  state.assertStoredProviderModelRuntimeMatch.mockImplementation(async (_input: {modelId: string}) => {})
  state.getStoredProviderModelRuntimeMatch.mockImplementation(async (_input: {modelId: string}) => {
    return {message: null, ok: true}
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
  queuedPromptId,
}: {
  articleId: string
  jobId: string
  promptId: string
  queuedPromptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Assess this article', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Test article')
  `)
  await runDatabase(`
    INSERT INTO app.judgment_job_prompt (id, job_id, article_id, prompt_id, status)
    VALUES ('${queuedPromptId}', '${jobId}', '${articleId}', '${promptId}', 'ready')
  `)
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
    queuedPromptId: `pause-queue-${Date.now()}`,
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
    queuedPromptId: `delete-queue-${Date.now()}`,
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

import {afterAll, afterEach, beforeAll, describe, expect, mock, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-model-context-window')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url).href
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href

type TestDatabase = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: TestDatabase | null = null
let closeDatabase: (() => Promise<void>) | null = null

const missingWindowMessage =
  'Model LM Studio Qwen (llmstudio) has no verified context window. Add it on the Models page.'

const getApp = () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  return app
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  return database
}

beforeAll(async () => {
  void mock.module(providerRuntimeModelGuardModulePath, () => {
    return {
      assertStoredProviderModelRuntimeMatch: async () => {
        return undefined
      },
      getStoredProviderModelRuntimeMatch: async () => {
        return {message: null, ok: true, reason: null}
      },
    }
  })
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    const getTestReadOnlyDatabase = () => {
      return {
        queryJson: <T>(statement: string) => {
          return getDatabase().queryJson<T>(statement)
        },
      }
    }

    return {
      closeAppReadOnlyDatabaseServices: async () => {
        return undefined
      },
      getApiReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
      getJudgeWorkerReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
    }
  })

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])
  const {judgmentsJobsRoutes} = (await import(
    `./JudgmentsJobsRoutes.ts?model-context-window=${Date.now()}`
  )) as typeof import('./JudgmentsJobsRoutes.ts')

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const appDatabase = getAppDatabaseService()

  database = appDatabase
  closeDatabase = () => {
    return appDatabase.close()
  }
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterEach(async () => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

const createFixture = async ({prefix, withJob}: {prefix: string; withJob: boolean}) => {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const db = getDatabase()

  await db.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'llmstudio', 'LM Studio', TRUE, 'none')
  `)
  await db.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'LM Studio Qwen', 'qwen2.5-1.5b-instruct', 'LM Studio Qwen', 'discovered', TRUE)
  `)
  await db.run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Model Context Window Project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)

  if (withJob) {
    await db.run(`
      INSERT INTO app.judgment_job (id, project_id, status, storage_state, created_at)
      VALUES ('${jobId}', '${projectId}', 'paused', 'active', current_timestamp - INTERVAL 1 HOUR)
    `)
  }

  return {connectionId, jobId, modelId, projectId}
}

const setUserContextWindow = async (modelId: string) => {
  await getDatabase().run(`
    UPDATE app.model
    SET metadata_json = '{"capabilityOverrides":{"contextWindow":{"inputTokens":4096,"totalTokens":4096},"updatedAt":"2026-10-17T10:00:00.000Z"}}'
    WHERE id = '${modelId}'
  `)
}

const sendJson = (path: string, method: string, body: Record<string, unknown>) => {
  return getApp().handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method,
    }),
  )
}

const getStoredJobStatus = async (jobId: string) => {
  const [job] = await getDatabase().queryJson<{status: string}>(`
    SELECT status FROM app.judgment_job WHERE id = '${jobId}'
  `)

  return job?.status ?? null
}

describe('model context window guard', () => {
  test('job start rejects with 409 and creates no job when the project model has no context window', async () => {
    const {projectId} = await createFixture({prefix: 'start-missing', withJob: false})
    const response = await sendJson('/api/judgmentsjobs', 'POST', {projectId})
    const [jobCount] = await getDatabase().queryJson<{count: number}>(`
      SELECT COUNT(*)::INTEGER AS count FROM app.judgment_job WHERE project_id = '${projectId}'
    `)

    expect(response.status).toBe(409)
    expect(await response.text()).toContain(missingWindowMessage)
    expect(jobCount?.count).toBe(0)
  })

  test('resume rejects with 409 and leaves the job paused until a context window is set', async () => {
    const {jobId, modelId} = await createFixture({prefix: 'resume-missing', withJob: true})
    const refused = await sendJson(`/api/judgmentsjobs/${jobId}`, 'PATCH', {status: 'running'})

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain(missingWindowMessage)
    expect(await getStoredJobStatus(jobId)).toBe('paused')

    await setUserContextWindow(modelId)

    const resumed = await sendJson(`/api/judgmentsjobs/${jobId}`, 'PATCH', {status: 'running'})

    expect(resumed.status).toBe(200)
    expect(await getStoredJobStatus(jobId)).toBe('running')
  })

  test('start clean rejects with 409 when the project model has no context window', async () => {
    const {jobId} = await createFixture({prefix: 'start-clean-missing', withJob: true})
    const refused = await getApp().handle(
      new Request(`http://localhost/api/judgmentsjobs/${jobId}/start-clean`, {method: 'POST'}),
    )

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain(missingWindowMessage)
  })

  test('the jobs list reports the missing window with a link to the Models page', async () => {
    const {connectionId, jobId} = await createFixture({prefix: 'list-missing', withJob: true})
    const response = await getApp().handle(new Request('http://localhost/api/judgmentsjobs'))
    const body = (await response.json()) as {data: Array<{id: string; modelContextWindow: unknown}>}

    expect(
      body.data.find((job) => {
        return job.id === jobId
      })?.modelContextWindow,
    ).toEqual({
      linkPath: `/providers/${connectionId}`,
      linkText: 'Models page',
      message: missingWindowMessage,
      modelName: 'LM Studio Qwen',
      providerKind: 'llmstudio',
    })
  })
})

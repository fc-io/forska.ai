import {afterAll, afterEach, beforeAll, describe, expect, mock, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {fullTextStrategyErrorMessages} from '../../utils/fullTextStrategyOptions.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('judgments-jobs-full-text-gate')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url).href
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href

type TestDatabase = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type FullTextGatePayload = {errors: string[]; warnings: string[]}

type StoredArticle = {
  fullText: string | null
  fullTextAssets: string | null
  fullTextCanonicalVersion: string | null
  fullTextConversionAttempts: number | null
  fullTextConversionStatus: string | null
  fullTextPdf: string | null
}

const mineruConnectionId = 'gate-mineru-connection'
const mineruModelId = 'gate-mineru-model'
const chunkPolicy = {maxPromptTokens: 48_000, mode: 'chunked'}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: TestDatabase | null = null
let closeDatabase: (() => Promise<void>) | null = null
let currentStrategy: {id: string; inputs: Record<string, unknown>; label: string} | null = null

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

const getCurrentStrategy = () => {
  if (!currentStrategy) {
    throw new Error('Strategy not resolved')
  }

  return currentStrategy
}

const setConversionModel = async (modelId: string | null) => {
  await getDatabase().run('DELETE FROM app.user_config')
  await getDatabase().run(`
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id)
    VALUES ('local-user', 'Local user', 'local@example.com', NULL, ${modelId ? `'${modelId}'` : 'NULL'})
  `)
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
    `./JudgmentsJobsRoutes.ts?full-text-gate=${Date.now()}`
  )) as typeof import('./JudgmentsJobsRoutes.ts')

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const appDatabase = getAppDatabaseService()

  database = appDatabase
  closeDatabase = () => {
    return appDatabase.close()
  }

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, last_checked_at)
    VALUES ('${mineruConnectionId}', 'mineru', 'MinerU', TRUE, 'none', 'http://127.0.0.1:8000', current_timestamp)
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('${mineruModelId}', '${mineruConnectionId}', 'mineru-standard', 'mineru-standard', 'MinerU standard', 'provider', TRUE,
      '{"converter":{"kind":"mineru","serverVersion":"4.0.12","tier":"standard"}}')
  `)
  await setConversionModel(mineruModelId)

  const [{getFullTextStrategyEnvironment}, {resolveFullTextStrategy}, {upsertFullTextStrategy}] = await Promise.all([
    import('../fullText/fullTextStrategyEnvironment.ts'),
    import('../fullText/fullTextStrategyResolver.ts'),
    import('../fullText/fullTextStrategyRepository.ts'),
  ])
  const resolution = resolveFullTextStrategy(
    {chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'}, figureMode: 'none'},
    await getFullTextStrategyEnvironment(),
  )

  if (!resolution.strategy) {
    throw new Error(`Strategy did not resolve: ${resolution.errors.join(' ')}`)
  }

  await upsertFullTextStrategy(appDatabase, resolution.strategy)
  currentStrategy = resolution.strategy
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterEach(async () => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await setConversionModel(mineruModelId)
  await getDatabase().run(`UPDATE app.provider_connection SET last_error = NULL WHERE id = '${mineruConnectionId}'`)
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

const createFixture = async ({
  inputTokens = 131_072,
  prefix,
  strategyId = getCurrentStrategy().id,
  withJob,
}: {
  inputTokens?: number
  prefix: string
  strategyId?: string
  withJob: boolean
}) => {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const db = getDatabase()

  await db.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await db.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('${modelId}', '${connectionId}', 'judge', 'judge', 'Judge', 'discovered', TRUE,
      '{"discovery":{"contextWindow":{"inputTokens":${inputTokens},"outputTokens":null,"totalTokens":${inputTokens}}}}')
  `)
  await db.run(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      full_text_figure_mode, full_text_chunk_policy, full_text_strategy_id
    )
    VALUES (
      '${projectId}', 'Full Text Gate Project', '${modelId}', TRUE, TRUE, TRUE, FALSE,
      'none', '${JSON.stringify(chunkPolicy)}'::JSON, '${strategyId}'
    )
  `)

  if (withJob) {
    await db.run(`
      INSERT INTO app.judgment_job (id, project_id, status, storage_state, full_text_strategy_id, created_at)
      VALUES ('${jobId}', '${projectId}', 'paused', 'active', '${strategyId}', current_timestamp - INTERVAL 1 HOUR)
    `)
  }

  return {jobId, modelId, projectId}
}

const insertConvertedArticle = async ({
  articleId,
  converterVersion,
  projectId,
}: {
  articleId: string
  converterVersion: string
  projectId: string
}) => {
  const inputs = getCurrentStrategy().inputs

  await getDatabase().run(`
    INSERT INTO app.article (
      id, article_title, full_text_pdf, full_text, full_text_canonical_version, full_text_canonical_hash,
      full_text_figure_mode_built, full_text_conversion_status, full_text_conversion_attempts,
      full_text_conversion_metadata, full_text_assets
    ) VALUES (
      '${articleId}', 'Article', 'assets/article_pdfs/${articleId}.pdf', 'Canonical text', '${String(inputs.canonicalTextVersion)}',
      'hash', 'markers', 'success', 2,
      '{"converterKind":"mineru","converterVersion":"${converterVersion}","optionsHash":"${String(inputs.converterOptionsHash)}"}'::JSON,
      '[{"index":1,"path":"assets/full-text-assets/${articleId}/fig-1.jpg"}]'::JSON
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${articleId}-link', '${projectId}', '${articleId}')
  `)
}

const getStoredArticle = async (articleId: string) => {
  const [row] = await getDatabase().queryJson<StoredArticle>(`
    SELECT
      full_text AS fullText,
      CAST(full_text_assets AS VARCHAR) AS fullTextAssets,
      full_text_canonical_version AS fullTextCanonicalVersion,
      full_text_conversion_attempts AS fullTextConversionAttempts,
      full_text_conversion_status AS fullTextConversionStatus,
      full_text_pdf AS fullTextPdf
    FROM app.article
    WHERE id = '${articleId}'
  `)

  return row ?? null
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

const getJobCount = async (projectId: string) => {
  const [row] = await getDatabase().queryJson<{count: number}>(`
    SELECT COUNT(*)::INTEGER AS count FROM app.judgment_job WHERE project_id = '${projectId}'
  `)

  return row?.count ?? 0
}

describe('full-text gate on job start and resume', () => {
  test('job start is a 409 naming the missing PDF-to-text model and creates no job', async () => {
    const {projectId} = await createFixture({prefix: 'start-no-conversion', withJob: false})

    await setConversionModel(null)

    const response = await sendJson('/api/judgmentsjobs', 'POST', {projectId})

    expect(response.status).toBe(409)
    expect(await response.text()).toContain(fullTextStrategyErrorMessages.conversionModelMissing)
    expect(await getJobCount(projectId)).toBe(0)
  })

  test('job start is a 409 when the stored strategy differs from the freshly resolved one', async () => {
    const {projectId} = await createFixture({prefix: 'start-drift', strategyId: 'fts-legacy-v0', withJob: false})
    const response = await sendJson('/api/judgmentsjobs', 'POST', {projectId})
    const text = await response.text()

    expect(response.status).toBe(409)
    expect(text).toContain(
      `Full-text settings changed since the project was saved: it records legacy full text (before strategy tracking) (fts-legacy-v0), current settings resolve to ${getCurrentStrategy().label} (${getCurrentStrategy().id}).`,
    )
  })

  test('resume is a 409 with both token counts when the model window is below the prompt size', async () => {
    const {jobId} = await createFixture({inputTokens: 32_768, prefix: 'resume-small-window', withJob: true})
    const response = await sendJson(`/api/judgmentsjobs/${jobId}`, 'PATCH', {status: 'running'})
    const [job] = await getDatabase().queryJson<{status: string}>(
      `SELECT status FROM app.judgment_job WHERE id = '${jobId}'`,
    )

    expect(response.status).toBe(409)
    expect(await response.text()).toContain(
      "Model Judge (sglang) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size.",
    )
    expect(job?.status).toBe('paused')
  })

  test('start clean is a 409 with the same gate errors', async () => {
    const {jobId} = await createFixture({inputTokens: 32_768, prefix: 'start-clean-small-window', withJob: true})
    const response = await getApp().handle(
      new Request(`http://localhost/api/judgmentsjobs/${jobId}/start-clean`, {method: 'POST'}),
    )

    expect(response.status).toBe(409)
    expect(await response.text()).toContain('accepts 32,768 prompt tokens')
  })

  test('job start queues articles converted with other versions for reconversion, then starts', async () => {
    const {projectId} = await createFixture({prefix: 'start-reconvert', withJob: false})
    const staleArticleId = `${projectId}-stale`
    const currentArticleId = `${projectId}-current`

    await insertConvertedArticle({articleId: staleArticleId, converterVersion: '4.0.11', projectId})
    await insertConvertedArticle({articleId: currentArticleId, converterVersion: '4.0.12', projectId})

    const refused = await sendJson('/api/judgmentsjobs', 'POST', {projectId})

    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain(
      `1 article is being reconverted for strategy ${getCurrentStrategy().label} (${getCurrentStrategy().id}); start again when conversion has finished.`,
    )
    expect(await getJobCount(projectId)).toBe(0)
    expect(await getStoredArticle(staleArticleId)).toEqual({
      fullText: null,
      fullTextAssets: `[{"index":1,"path":"assets/full-text-assets/${staleArticleId}/fig-1.jpg"}]`,
      fullTextCanonicalVersion: null,
      fullTextConversionAttempts: 0,
      fullTextConversionStatus: null,
      fullTextPdf: `assets/article_pdfs/${staleArticleId}.pdf`,
    })
    expect((await getStoredArticle(currentArticleId))?.fullText).toBe('Canonical text')

    const started = await sendJson('/api/judgmentsjobs', 'POST', {projectId})

    expect(started.status).toBe(200)
    expect(await getJobCount(projectId)).toBe(1)
  })
})

describe('full-text gate in job payloads', () => {
  test('the jobs list and job detail carry the gate errors and the health warning', async () => {
    const {jobId} = await createFixture({inputTokens: 32_768, prefix: 'list-gate', withJob: true})

    await getDatabase().run(`
      UPDATE app.provider_connection SET last_error = 'connect ECONNREFUSED' WHERE id = '${mineruConnectionId}'
    `)

    const listResponse = await getApp().handle(new Request('http://localhost/api/judgmentsjobs'))
    const listBody = (await listResponse.json()) as {data: Array<{fullTextGate: FullTextGatePayload; id: string}>}
    const listGate = listBody.data.find((job) => {
      return job.id === jobId
    })?.fullTextGate
    const detailResponse = await getApp().handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}`))
    const detailBody = (await detailResponse.json()) as {fullTextGate: FullTextGatePayload}

    expect(listResponse.status).toBe(200)
    expect(listGate?.errors).toEqual([
      "Model Judge (sglang) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page.",
    ])
    expect(listGate?.warnings).toHaveLength(1)
    expect(listGate?.warnings[0]).toContain('PDF-to-text model MinerU standard: The last health check of MinerU failed')
    expect(detailResponse.status).toBe(200)
    expect(detailBody.fullTextGate).toEqual(listGate as FullTextGatePayload)
  })

  test('a project without full text carries an empty gate', async () => {
    const {jobId, projectId} = await createFixture({prefix: 'list-no-full-text', withJob: true})

    await getDatabase().run(`
      UPDATE app.project
      SET use_fulltext = FALSE, full_text_figure_mode = NULL, full_text_chunk_policy = NULL, full_text_strategy_id = NULL
      WHERE id = '${projectId}'
    `)

    const response = await getApp().handle(new Request('http://localhost/api/judgmentsjobs'))
    const body = (await response.json()) as {data: Array<{fullTextGate: FullTextGatePayload; id: string}>}

    expect(
      body.data.find((job) => {
        return job.id === jobId
      })?.fullTextGate,
    ).toEqual({errors: [], warnings: []})
  })
})

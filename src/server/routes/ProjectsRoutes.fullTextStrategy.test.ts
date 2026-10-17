import {afterAll, beforeAll, expect, mock, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('projects-routes-full-text-strategy')
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href
const canonicalTextVersionModulePath = new URL('../fullText/fullTextCanonicalTextVersion.ts', import.meta.url).href

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const judgeConnectionId = 'fts-judge-connection'
const judgeModelId = 'fts-judge-model'
const mineruConnectionId = 'fts-mineru-connection'
const mineruModelId = 'fts-mineru-model'
const mineruUnversionedModelId = 'fts-mineru-unversioned-model'
const chunkPolicy = {maxPromptTokens: 48_000, mode: 'chunked'}

type ProjectResponse = {
  data: {
    fullTextChunkPolicy: unknown
    fullTextFigureMode: string | null
    fullTextStrategyId: string | null
    fullTextStrategyLabel: string
    id: string
    useFulltext: boolean
    useFulltextNoImages: boolean
  }
}

type EditResponse = {data: {project: ProjectResponse['data']}}

type PreviewResponse = {
  data: {
    current: {judgmentCount: number; strategyId: string; strategyLabel: string} | null
    errors: string[]
    strategyId: string | null
    strategyLabel: string | null
  }
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

const getDatabase = () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  return database
}

const registerModuleMocks = () => {
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    return {
      closeAppReadOnlyDatabaseServices: async () => {},
      getApiReadOnlyAppDatabaseService: getDatabase,
      getJudgeWorkerReadOnlyAppDatabaseService: getDatabase,
    }
  })
  void mock.module(canonicalTextVersionModulePath, () => {
    return {fullTextCanonicalTextVersion: 'canonical-test'}
  })
}

const requestJson = async (path: string, method: 'PATCH' | 'POST', body: Record<string, unknown>) => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method,
    }),
  )
  const text = await response.text()

  return {json: (text.startsWith('{') ? JSON.parse(text) : null) as unknown, status: response.status, text}
}

const setConversionModel = async (modelId: string | null) => {
  await getDatabase().run('DELETE FROM app.user_config')
  await getDatabase().run(`
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id)
    VALUES ('local-user', 'Local user', 'local@example.com', NULL, ${modelId ? `'${modelId}'` : 'NULL'})
  `)
}

const insertProject = async (input: {
  fullTextStrategyId: string | null
  id: string
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  await getDatabase().run(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      full_text_figure_mode, full_text_strategy_id, archived
    ) VALUES (
      '${input.id}', '${input.id}', '${judgeModelId}', FALSE, FALSE,
      ${input.useFulltext ? 'TRUE' : 'FALSE'}, ${input.useFulltextNoImages ? 'TRUE' : 'FALSE'},
      ${input.fullTextStrategyId ? "'none'" : 'NULL'},
      ${input.fullTextStrategyId ? `'${input.fullTextStrategyId}'` : 'NULL'},
      FALSE
    )
  `)
}

const getStoredProject = async (projectId: string) => {
  const [row] = await getDatabase().queryJson<{
    fullTextChunkPolicy: string | null
    fullTextFigureMode: string | null
    fullTextStrategyId: string | null
    useFulltext: boolean
    useFulltextNoImages: boolean
  }>(`
    SELECT
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      full_text_figure_mode AS fullTextFigureMode,
      CAST(full_text_chunk_policy AS VARCHAR) AS fullTextChunkPolicy,
      full_text_strategy_id AS fullTextStrategyId
    FROM app.project
    WHERE id = '${projectId}'
  `)

  return row ?? null
}

beforeAll(async () => {
  registerModuleMocks()

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()
  database = getAppDatabaseService()

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES
      ('${judgeConnectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://127.0.0.1:30000/v1'),
      ('${mineruConnectionId}', 'mineru', 'MinerU', TRUE, 'none', 'http://127.0.0.1:8000')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES
      ('${judgeModelId}', '${judgeConnectionId}', 'judge', 'judge', 'Judge', 'manual', TRUE, NULL),
      ('${mineruModelId}', '${mineruConnectionId}', 'mineru-standard', 'mineru-standard', 'MinerU standard', 'provider', TRUE,
        '{"converter":{"kind":"mineru","serverVersion":"4.0.12","tier":"standard"}}'),
      ('${mineruUnversionedModelId}', '${mineruConnectionId}', 'mineru-manual', 'mineru-manual', 'MinerU manual', 'manual', TRUE, NULL)
  `)

  const {projectsRoutes} = await import('./ProjectsRoutes.ts')

  app = new Elysia().use(projectsRoutes)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

test('create with full text and no figure mode or chunk policy is a 400 naming both', async () => {
  await setConversionModel(mineruModelId)

  const response = await requestJson('/api/projects', 'POST', {
    modelId: judgeModelId,
    name: 'Missing full text choices',
    useFulltext: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Full text needs a figure mode')
  expect(response.text).toContain('Full text needs a chunk policy')
})

test('create with full text and no PDF-to-text model is a 400 pointing at Settings', async () => {
  await setConversionModel(null)

  const response = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: judgeModelId,
    name: 'No conversion model',
    useFulltext: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Full text needs a PDF-to-text model. Set it in Settings → PDF conversion.')
})

test('create with a conversion model that never reported a server version is a 400 naming the model', async () => {
  await setConversionModel(mineruUnversionedModelId)

  const response = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: judgeModelId,
    name: 'Unversioned conversion model',
    useFulltext: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('MinerU manual has not reported a server version')
})

test('create rejects the retired no-images flag', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    modelId: judgeModelId,
    name: 'Retired no images flag',
    useFulltextNoImages: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('useFulltextNoImages is replaced by fullTextFigureMode "none"')
})

test('create with explicit full-text choices stores the derived strategy and registers it', async () => {
  await setConversionModel(mineruModelId)

  const response = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: judgeModelId,
    name: 'Full text project',
    useFulltext: true,
  })
  const project = (response.json as ProjectResponse).data

  expect(response.status).toBe(200)
  expect(project.fullTextFigureMode).toBe('none')
  expect(project.fullTextChunkPolicy).toEqual(chunkPolicy)
  expect(project.fullTextStrategyId).toMatch(/^fts-[0-9a-f]{16}$/)
  expect(project.fullTextStrategyLabel).toBe('mineru 4.0.12 / none / chunked 48k')
  expect(await getStoredProject(project.id)).toMatchObject({useFulltext: true, useFulltextNoImages: false})
  expect(
    await getDatabase().queryJson<{label: string}>(`
      SELECT label FROM app.full_text_strategy WHERE id = '${project.fullTextStrategyId}'
    `),
  ).toEqual([{label: 'mineru 4.0.12 / none / chunked 48k'}])
})

test('create without full text ignores figure choices and stores no strategy', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: judgeModelId,
    name: 'Abstract project',
    useFulltext: false,
  })
  const project = (response.json as ProjectResponse).data

  expect(response.status).toBe(200)
  expect(project).toMatchObject({
    fullTextChunkPolicy: null,
    fullTextFigureMode: null,
    fullTextStrategyId: null,
    fullTextStrategyLabel: 'no full text',
  })
})

test('editing a legacy no-images project to explicit choices moves it to a derived strategy', async () => {
  await setConversionModel(mineruModelId)
  await insertProject({
    fullTextStrategyId: 'fts-legacy-v0',
    id: 'fts-legacy-project',
    useFulltext: false,
    useFulltextNoImages: true,
  })

  const response = await requestJson('/api/projects/fts-legacy-project/edit', 'PATCH', {
    fullTextChunkPolicy: {maxPromptTokens: 96_000, mode: 'single_only'},
    fullTextFigureMode: 'none',
    useFulltext: true,
  })
  const project = (response.json as EditResponse).data.project

  expect(response.status).toBe(200)
  expect(project.fullTextStrategyLabel).toBe('mineru 4.0.12 / none / single 96k')
  expect(await getStoredProject('fts-legacy-project')).toMatchObject({
    fullTextFigureMode: 'none',
    useFulltext: true,
    useFulltextNoImages: false,
  })
  expect((await getStoredProject('fts-legacy-project'))?.fullTextStrategyId).toBe(project.fullTextStrategyId)
})

test('editing away the chunk policy of a full-text project is a 400', async () => {
  const response = await requestJson('/api/projects/fts-legacy-project/edit', 'PATCH', {fullTextChunkPolicy: null})

  expect(response.status).toBe(400)
  expect(response.text).toContain('Full text needs a chunk policy')
})

test('turning full text off clears the full-text settings and the strategy', async () => {
  const response = await requestJson('/api/projects/fts-legacy-project/edit', 'PATCH', {useFulltext: false})

  expect(response.status).toBe(200)
  expect(await getStoredProject('fts-legacy-project')).toEqual({
    fullTextChunkPolicy: null,
    fullTextFigureMode: null,
    fullTextStrategyId: null,
    useFulltext: false,
    useFulltextNoImages: false,
  })
})

test('full-text settings are protected once a judgment job exists', async () => {
  await insertProject({
    fullTextStrategyId: 'fts-legacy-v0',
    id: 'fts-job-project',
    useFulltext: true,
    useFulltextNoImages: false,
  })
  await getDatabase().run(`
    INSERT INTO app.judgment_job (id, project_id, status) VALUES ('fts-job', 'fts-job-project', 'paused')
  `)

  const response = await requestJson('/api/projects/fts-job-project/edit', 'PATCH', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'descriptions',
  })

  expect(response.status).toBe(409)
  expect(response.text).toContain('fullTextFigureMode')
  expect(response.text).toContain('fullTextChunkPolicy')
})

test('the preview derives the strategy and reports the existing judgments under the current one', async () => {
  await insertProject({
    fullTextStrategyId: 'fts-legacy-v0',
    id: 'fts-preview-project',
    useFulltext: true,
    useFulltextNoImages: false,
  })
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title) VALUES ('fts-article-1', 'Article 1'), ('fts-article-2', 'Article 2')
  `)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('fts-prompt', 'Is it a trial?')`)
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled)
    VALUES ('fts-project-prompt', 'fts-preview-project', 'fts-prompt', 0, FALSE, TRUE)
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      full_text_strategy_id, is_answered, answered_original
    ) VALUES
      ('fts-judgment-legacy-1', 'fts-article-1', 'fts-prompt', '${judgeModelId}', FALSE, FALSE, TRUE, FALSE, 'fts-legacy-v0', TRUE, 'yes'),
      ('fts-judgment-legacy-2', 'fts-article-2', 'fts-prompt', '${judgeModelId}', FALSE, FALSE, TRUE, FALSE, 'fts-legacy-v0', TRUE, 'no'),
      ('fts-judgment-other', 'fts-article-1', 'fts-prompt', '${judgeModelId}', FALSE, FALSE, TRUE, FALSE, 'fts-0123456789abcdef', TRUE, 'no')
  `)

  const response = await requestJson('/api/projects/full-text-strategy-preview', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    projectId: 'fts-preview-project',
    useFulltext: true,
  })
  const preview = (response.json as PreviewResponse).data

  expect(response.status).toBe(200)
  expect(preview.errors).toEqual([])
  expect(preview.strategyLabel).toBe('mineru 4.0.12 / none / chunked 48k')
  expect(preview.current).toEqual({
    judgmentCount: 2,
    strategyId: 'fts-legacy-v0',
    strategyLabel: 'legacy full text (before strategy tracking)',
  })
})

test('the preview lists every missing input and reports no full text when it is off', async () => {
  const missing = await requestJson('/api/projects/full-text-strategy-preview', 'POST', {useFulltext: true})
  const off = await requestJson('/api/projects/full-text-strategy-preview', 'POST', {useFulltext: false})

  expect((missing.json as PreviewResponse).data).toMatchObject({strategyId: null, strategyLabel: null})
  expect((missing.json as PreviewResponse).data.errors).toHaveLength(2)
  expect((off.json as PreviewResponse).data).toMatchObject({
    current: null,
    errors: [],
    strategyId: 'fts-none',
    strategyLabel: 'no full text',
  })
})

test('a full-text strategy change marks comparisons linking the project stale', async () => {
  await setConversionModel(mineruModelId)
  await insertProject({
    fullTextStrategyId: 'fts-legacy-v0',
    id: 'fts-stale-project',
    useFulltext: true,
    useFulltextNoImages: false,
  })
  await getDatabase().run(`
    INSERT INTO app.comparison_project (id, name, model_ids, compare_with_humans, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('fts-stale-linked', 'Linked comparison', ['${judgeModelId}'], FALSE, FALSE, FALSE, TRUE, FALSE),
      ('fts-stale-unlinked', 'Unlinked comparison', ['${judgeModelId}'], FALSE, FALSE, FALSE, TRUE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES ('fts-stale-link', 'fts-stale-linked', 'fts-stale-project')
  `)
  await getDatabase().run(`
    INSERT INTO app.comparison_project_serving_generation (
      comparison_project_id, active_generation, generation_updated_at, serving_status, serving_generation, serving_completed_at
    )
    VALUES
      ('fts-stale-linked', 1, current_timestamp, 'ready', 1, current_timestamp),
      ('fts-stale-unlinked', 1, current_timestamp, 'ready', 1, current_timestamp)
  `)

  const getServingStatuses = () => {
    return getDatabase().queryJson<{comparisonProjectId: string; servingStatus: string}>(`
      SELECT comparison_project_id AS comparisonProjectId, serving_status AS servingStatus
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id LIKE 'fts-stale-%'
      ORDER BY comparison_project_id
    `)
  }
  const nameResponse = await requestJson('/api/projects/fts-stale-project/edit', 'PATCH', {name: 'Renamed'})

  expect(nameResponse.status).toBe(200)
  expect(await getServingStatuses()).toEqual([
    {comparisonProjectId: 'fts-stale-linked', servingStatus: 'ready'},
    {comparisonProjectId: 'fts-stale-unlinked', servingStatus: 'ready'},
  ])

  const strategyResponse = await requestJson('/api/projects/fts-stale-project/edit', 'PATCH', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
  })

  expect(strategyResponse.status).toBe(200)
  expect((await getStoredProject('fts-stale-project'))?.fullTextStrategyId).not.toBe('fts-legacy-v0')
  expect(await getServingStatuses()).toEqual([
    {comparisonProjectId: 'fts-stale-linked', servingStatus: 'stale'},
    {comparisonProjectId: 'fts-stale-unlinked', servingStatus: 'ready'},
  ])
})

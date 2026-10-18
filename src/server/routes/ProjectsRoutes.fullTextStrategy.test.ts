import {afterAll, beforeAll, expect, mock, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {legacyFullTextNoImagesBodyErrorMessage} from '../utils/rejectLegacyFullTextNoImagesBody.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('projects-routes-full-text-strategy')
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href

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
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id, unpaywall_email)
    VALUES ('local-user', 'Local user', 'local@example.com', NULL, ${modelId ? `'${modelId}'` : 'NULL'}, 'local@example.com')
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
      ('${judgeModelId}', '${judgeConnectionId}', 'judge', 'judge', 'Judge', 'manual', TRUE,
        '{"discovery":{"contextWindow":{"inputTokens":131072,"outputTokens":null,"totalTokens":131072}}}'),
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

test('create rejects the frozen no-images flag', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    modelId: judgeModelId,
    name: 'Retired no images flag',
    useFulltextNoImages: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain(legacyFullTextNoImagesBodyErrorMessage)
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
    fullTextFigureMode: 'native_images',
  })

  expect(response.status).toBe(409)
  expect(response.text).toContain('fullTextFigureMode')
  expect(response.text).toContain('fullTextChunkPolicy')
})

test('a locked legacy no-images project keeps its flag when the edit page resubmits full text on', async () => {
  await insertProject({
    fullTextStrategyId: 'fts-legacy-v0',
    id: 'fts-legacy-locked-project',
    useFulltext: false,
    useFulltextNoImages: true,
  })
  await getDatabase().run(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('fts-legacy-locked-job', 'fts-legacy-locked-project', 'paused')
  `)

  const response = await requestJson('/api/projects/fts-legacy-locked-project/edit', 'PATCH', {
    name: 'Renamed legacy no-images project',
    useFulltext: true,
  })

  expect(response.status).toBe(200)
  expect((response.json as EditResponse).data.project.fullTextStrategyLabel).toBe('full text (legacy, no images)')
  expect(await getStoredProject('fts-legacy-locked-project')).toMatchObject({
    fullTextStrategyId: 'fts-legacy-v0',
    useFulltext: false,
    useFulltextNoImages: true,
  })
})

test('a locked legacy no-images project still refuses turning full text off', async () => {
  const response = await requestJson('/api/projects/fts-legacy-locked-project/edit', 'PATCH', {useFulltext: false})

  expect(response.status).toBe(409)
  expect(response.text).toContain('useFulltext')
  expect(await getStoredProject('fts-legacy-locked-project')).toMatchObject({useFulltextNoImages: true})
})

test('cloning a legacy no-images project copies the stored flag and the legacy strategy', async () => {
  const response = await requestJson('/api/projects/fts-legacy-locked-project/clone', 'POST', {})
  const clonedProjectId = (response.json as {data: {id: string}}).data.id

  expect(response.status).toBe(200)
  expect(await getStoredProject(clonedProjectId)).toMatchObject({
    fullTextStrategyId: 'fts-legacy-v0',
    useFulltext: false,
    useFulltextNoImages: true,
  })
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

  const response = await requestJson('/api/projects/full-text-validation', 'POST', {
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
  const missing = await requestJson('/api/projects/full-text-validation', 'POST', {useFulltext: true})
  const off = await requestJson('/api/projects/full-text-validation', 'POST', {useFulltext: false})

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

type ValidationResponse = {
  data: PreviewResponse['data'] & {
    modelAcceptsImages: boolean
    modelLabel: string | null
    recordStrategyOnSave: boolean
    warnings: string[]
  }
}

const smallJudgeModelId = 'fts-small-judge-model'

const insertSmallJudgeModel = async () => {
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('${smallJudgeModelId}', '${judgeConnectionId}', 'small-judge', 'small-judge', 'Small judge', 'manual', TRUE,
      '{"discovery":{"contextWindow":{"inputTokens":32768,"outputTokens":null,"totalTokens":32768}}}')
    ON CONFLICT (id) DO NOTHING
  `)
}

const insertExplicitFullTextProject = async ({id, jobStatus}: {id: string; jobStatus: string | null}) => {
  await insertProject({fullTextStrategyId: 'fts-0000000000000000', id, useFulltext: true, useFulltextNoImages: false})
  await getDatabase().run(`
    UPDATE app.project SET full_text_chunk_policy = '${JSON.stringify(chunkPolicy)}'::JSON WHERE id = '${id}'
  `)

  if (jobStatus) {
    await getDatabase().run(`
      INSERT INTO app.judgment_job (id, project_id, status) VALUES ('${id}-job', '${id}', '${jobStatus}')
    `)
  }
}

test('create with a model whose window is below the chunk prompt size is a 400 with both numbers', async () => {
  await setConversionModel(mineruModelId)
  await insertSmallJudgeModel()

  const response = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: smallJudgeModelId,
    name: 'Small window',
    useFulltext: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain(
    "Model Small judge (sglang) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size.",
  )
})

test('create with native images and a model without verified image input is a 400 naming the model', async () => {
  await setConversionModel(mineruModelId)

  const response = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'native_images',
    modelId: judgeModelId,
    name: 'Native images',
    useFulltext: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Model Judge (sglang) has no verified image input.')
})

test('the validation endpoint returns gate errors for the form model and the PDF-to-text health warning', async () => {
  await setConversionModel(mineruModelId)
  await insertSmallJudgeModel()
  await getDatabase().run(`
    UPDATE app.provider_connection SET last_checked_at = current_timestamp, last_error = 'connect ECONNREFUSED'
    WHERE id = '${mineruConnectionId}'
  `)

  const response = await requestJson('/api/projects/full-text-validation', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: smallJudgeModelId,
    useFulltext: true,
  })
  const validation = (response.json as ValidationResponse).data

  await getDatabase().run(`UPDATE app.provider_connection SET last_error = NULL WHERE id = '${mineruConnectionId}'`)

  expect(response.status).toBe(200)
  expect(validation.errors).toEqual([
    "Model Small judge (sglang) accepts 32,768 prompt tokens, fewer than the chunk policy's 48,000-token prompt size. Choose a smaller prompt size or another model, or correct its context window on the Models page.",
  ])
  expect(validation.warnings).toHaveLength(1)
  expect(validation.warnings[0]).toContain('PDF-to-text model MinerU standard: The last health check of MinerU failed')
  expect(validation.warnings[0]).toContain(
    'connect ECONNREFUSED. Conversion will not run until the server is reachable.',
  )
  expect(validation.recordStrategyOnSave).toBe(false)
})

test('the body schemas refuse figure mode descriptions like any other invalid body value', async () => {
  await setConversionModel(mineruModelId)
  await insertProject({
    fullTextStrategyId: null,
    id: 'fts-descriptions-edit',
    useFulltext: false,
    useFulltextNoImages: false,
  })

  const create = await requestJson('/api/projects', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'descriptions',
    modelId: judgeModelId,
    name: 'Descriptions',
    useFulltext: true,
  })
  const validation = await requestJson('/api/projects/full-text-validation', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'descriptions',
    modelId: judgeModelId,
    useFulltext: true,
  })
  const edit = await requestJson('/api/projects/fts-descriptions-edit/edit', 'PATCH', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'descriptions',
    useFulltext: true,
  })

  expect([create.status, validation.status, edit.status]).toEqual([422, 422, 422])
  expect(create.text).toContain('fullTextFigureMode')
  expect(await getStoredProject('fts-descriptions-edit')).toMatchObject({fullTextFigureMode: null, useFulltext: false})
})

const visionJudgeModelId = 'fts-vision-judge-model'

const insertVisionJudgeModel = async () => {
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('${visionJudgeModelId}', '${judgeConnectionId}', 'vision-judge', 'vision-judge', 'Vision judge', 'manual', TRUE,
      '{"discovery":{"contextWindow":{"inputTokens":131072,"outputTokens":null,"totalTokens":131072}},"capabilityOverrides":{"supportsImageInput":true,"updatedAt":"2026-10-17T10:00:00.000Z"}}')
    ON CONFLICT (id) DO NOTHING
  `)
}

test('the validation endpoint reports whether the form model accepts images, from the same capability source', async () => {
  await setConversionModel(mineruModelId)
  await insertVisionJudgeModel()

  const validate = async (modelId: string | null, fullTextFigureMode: 'native_images' | 'none') => {
    const response = await requestJson('/api/projects/full-text-validation', 'POST', {
      fullTextChunkPolicy: chunkPolicy,
      fullTextFigureMode,
      modelId,
      useFulltext: true,
    })

    expect(response.status).toBe(200)

    return (response.json as ValidationResponse).data
  }
  const textJudgeTextOnly = await validate(judgeModelId, 'none')
  const textJudgeImages = await validate(judgeModelId, 'native_images')
  const visionJudgeImages = await validate(visionJudgeModelId, 'native_images')
  const noModel = await validate(null, 'none')

  expect(textJudgeTextOnly).toMatchObject({errors: [], modelAcceptsImages: false, modelLabel: 'Judge'})
  expect(textJudgeImages.modelAcceptsImages).toBe(false)
  expect(textJudgeImages.errors).toEqual([
    'Model Judge (sglang) has no verified image input. Set it on the Models page, or choose Text only (figures reduced to their captions), or another model.',
  ])
  expect(visionJudgeImages).toMatchObject({errors: [], modelAcceptsImages: true, modelLabel: 'Vision judge'})
  expect(visionJudgeImages.strategyLabel).toBe('mineru 4.0.12 / native images / chunked 48k')
  expect(noModel).toMatchObject({modelAcceptsImages: false, modelLabel: null})
})

test('text only stores the same strategy id for a vision and a non-vision model', async () => {
  await setConversionModel(mineruModelId)
  await insertVisionJudgeModel()

  const createTextOnlyProject = async (modelId: string, name: string) => {
    const response = await requestJson('/api/projects', 'POST', {
      fullTextChunkPolicy: chunkPolicy,
      fullTextFigureMode: 'none',
      modelId,
      name,
      useFulltext: true,
    })

    expect(response.status).toBe(200)

    return (response.json as ProjectResponse).data
  }
  const textModelProject = await createTextOnlyProject(judgeModelId, 'Text only, text model')
  const visionModelProject = await createTextOnlyProject(visionJudgeModelId, 'Text only, vision model')
  const storedTextModelProject = await getStoredProject(textModelProject.id)
  const storedVisionModelProject = await getStoredProject(visionModelProject.id)

  expect(storedTextModelProject?.fullTextFigureMode).toBe('none')
  expect(storedVisionModelProject?.fullTextFigureMode).toBe('none')
  expect(storedTextModelProject?.fullTextStrategyId).toMatch(/^fts-[0-9a-f]{16}$/)
  expect(storedVisionModelProject?.fullTextStrategyId).toBe(storedTextModelProject?.fullTextStrategyId ?? '')
  expect(visionModelProject.fullTextStrategyLabel).toBe(textModelProject.fullTextStrategyLabel)
  expect(textModelProject.fullTextStrategyLabel).toBe('mineru 4.0.12 / none / chunked 48k')
})

test('with a paused job the edit page records a drifted strategy on save', async () => {
  await setConversionModel(mineruModelId)
  await insertExplicitFullTextProject({id: 'fts-record-paused', jobStatus: 'paused'})

  const validationResponse = await requestJson('/api/projects/full-text-validation', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: judgeModelId,
    projectId: 'fts-record-paused',
    useFulltext: true,
  })
  const validation = (validationResponse.json as ValidationResponse).data
  const recordResponse = await requestJson('/api/projects/fts-record-paused/edit', 'PATCH', {
    name: 'Recorded',
    recordCurrentFullTextStrategy: true,
  })

  expect(validation.recordStrategyOnSave).toBe(true)
  expect(validation.warnings).toEqual([
    `Full-text settings changed since the project was saved: it records fts-0000000000000000 (fts-0000000000000000), current settings resolve to mineru 4.0.12 / none / chunked 48k (${validation.strategyId}). Saving this page records the new strategy; then start the judgment job clean.`,
  ])
  expect(recordResponse.status).toBe(200)
  expect((await getStoredProject('fts-record-paused'))?.fullTextStrategyId).toBe(validation.strategyId)
})

test('with a running job recording the strategy is a 409 and the stored strategy stays', async () => {
  await setConversionModel(mineruModelId)
  await insertExplicitFullTextProject({id: 'fts-record-running', jobStatus: 'running'})

  const validationResponse = await requestJson('/api/projects/full-text-validation', 'POST', {
    fullTextChunkPolicy: chunkPolicy,
    fullTextFigureMode: 'none',
    modelId: judgeModelId,
    projectId: 'fts-record-running',
    useFulltext: true,
  })
  const validation = (validationResponse.json as ValidationResponse).data
  const recordResponse = await requestJson('/api/projects/fts-record-running/edit', 'PATCH', {
    recordCurrentFullTextStrategy: true,
  })

  expect(validation.recordStrategyOnSave).toBe(false)
  expect(validation.warnings[0]).toContain('Pause the judgment job, then save this page to record the new strategy.')
  expect(recordResponse.status).toBe(409)
  expect(recordResponse.text).toContain('Pause the judgment job before recording a new full-text strategy.')
  expect((await getStoredProject('fts-record-running'))?.fullTextStrategyId).toBe('fts-0000000000000000')
})

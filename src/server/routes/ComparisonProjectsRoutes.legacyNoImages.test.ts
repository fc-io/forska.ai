import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {legacyFullTextNoImagesBodyErrorMessage} from '../utils/rejectLegacyFullTextNoImagesBody.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-legacy-no-images')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const legacyComparisonProjectId = 'legacy-no-images-comparison'
const legacySourceProjectId = 'legacy-no-images-source-project'
const modelId = 'legacy-no-images-model'
const promptId = 'legacy-no-images-prompt'

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

  return {status: response.status, text: await response.text()}
}

const getComparisonProjectsNamed = async (name: string) => {
  return getDatabase().queryJson<{useFulltext: boolean; useFulltextNoImages: boolean}>(`
    SELECT use_fulltext AS useFulltext, use_fulltext_no_images AS useFulltextNoImages
    FROM app.comparison_project
    WHERE name = '${name}'
  `)
}

const seedLegacyNoImagesFixture = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('legacy-no-images-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', 'legacy-no-images-connection', 'model-1', 'model-1', 'Model 1', 'manual', TRUE);

    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Legacy no-images prompt', 'legacy-no-images-prompt-hash');

    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      full_text_figure_mode, full_text_strategy_id, archived
    ) VALUES (
      '${legacySourceProjectId}', 'Legacy no-images source project', '${modelId}', FALSE, FALSE, FALSE, TRUE,
      'none', 'fts-legacy-v0', FALSE
    );

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('legacy-no-images-project-prompt', '${legacySourceProjectId}', '${promptId}', 0, TRUE);

    INSERT INTO app.comparison_project (
      id, name, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    ) VALUES (
      '${legacyComparisonProjectId}', 'Legacy no-images comparison', ['${modelId}'], FALSE, FALSE, 'prompt',
      FALSE, FALSE, FALSE, TRUE
    );

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES ('legacy-no-images-comparison-prompt', '${legacyComparisonProjectId}', '${promptId}', 0);
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {comparisonProjectsRoutes}] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ComparisonProjectsRoutes.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
  await seedLegacyNoImagesFixture()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test.each([true, false])('create rejects the frozen no-images flag sent as %p and stores nothing', async (value) => {
  const name = `Frozen flag comparison ${String(value)}`
  const response = await requestJson('/api/comparison-projects', 'POST', {
    name,
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: value,
    useTitle: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain(legacyFullTextNoImagesBodyErrorMessage)
  expect(await getComparisonProjectsNamed(name)).toEqual([])
})

test('create from project rejects the frozen no-images flag', async () => {
  const response = await requestJson('/api/comparison-projects/from-project', 'POST', {
    name: 'Frozen flag from project',
    sourceProjectId: legacySourceProjectId,
    useFulltextNoImages: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain(legacyFullTextNoImagesBodyErrorMessage)
  expect(await getComparisonProjectsNamed('Frozen flag from project')).toEqual([])
})

test('create from a legacy no-images project copies the stored flag', async () => {
  const response = await requestJson('/api/comparison-projects/from-project', 'POST', {
    name: 'Legacy copy from project',
    sourceProjectId: legacySourceProjectId,
  })

  expect(response.status).toBe(200)
  expect(await getComparisonProjectsNamed('Legacy copy from project')).toEqual([
    {useFulltext: false, useFulltextNoImages: true},
  ])
})

test('edit rejects the frozen no-images flag and leaves the comparison unchanged', async () => {
  const response = await requestJson(`/api/comparison-projects/${legacyComparisonProjectId}`, 'PATCH', {
    allowConflictResolution: false,
    compareWithHumans: false,
    name: 'Renamed by a frozen flag request',
    promptSelections: [{order: 0, promptId}],
    useAbstract: false,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: false,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain(legacyFullTextNoImagesBodyErrorMessage)
  expect(await getComparisonProjectsNamed('Legacy no-images comparison')).toEqual([
    {useFulltext: false, useFulltextNoImages: true},
  ])
})

test('edit of a legacy no-images comparison keeps the stored flag', async () => {
  const response = await requestJson(`/api/comparison-projects/${legacyComparisonProjectId}`, 'PATCH', {
    allowConflictResolution: false,
    compareWithHumans: false,
    name: 'Legacy no-images comparison renamed',
    promptSelections: [{order: 0, promptId}],
    useAbstract: false,
    useFulltext: false,
    useTitle: false,
  })

  expect(response.status).toBe(200)
  expect(await getComparisonProjectsNamed('Legacy no-images comparison renamed')).toEqual([
    {useFulltext: false, useFulltextNoImages: true},
  ])
})

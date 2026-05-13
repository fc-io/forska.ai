import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f2-comparison-projects-fk')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {comparisonProjectsRoutes}] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ComparisonProjectsRoutes.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

const seedComparisonProjectFixture = async () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('comparison-fk-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('comparison-fk-model-1', 'comparison-fk-connection', 'model-1', 'model-1', 'Model 1', 'manual', TRUE),
      ('comparison-fk-model-2', 'comparison-fk-connection', 'model-2', 'model-2', 'Model 2', 'manual', TRUE);

    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES
      ('comparison-fk-prompt-1', 'Original comparison prompt', 'comparison-fk-prompt-1-hash'),
      ('comparison-fk-prompt-2', 'Replacement comparison prompt', 'comparison-fk-prompt-2-hash');

    INSERT INTO app.article (id, article_title)
    VALUES ('comparison-fk-article', 'Comparison FK Article');

    INSERT INTO app.import_route (id, route, name)
    VALUES ('comparison-fk-import-route', '/comparison-fk', 'Comparison FK');

    INSERT INTO app.comparison_project (
      id,
      name,
      model_ids,
      compare_with_humans,
      allow_conflict_resolution,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    ) VALUES (
      'comparison-fk-project',
      'Comparison FK Project',
      ['comparison-fk-model-1'],
      FALSE,
      TRUE,
      'prompt',
      TRUE,
      TRUE,
      FALSE,
      FALSE
    );

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES ('comparison-fk-project-prompt', 'comparison-fk-project', 'comparison-fk-prompt-1', 0);

    INSERT INTO app.comparison_project_import_route (id, comparison_project_id, import_route_id)
    VALUES ('comparison-fk-project-route', 'comparison-fk-project', 'comparison-fk-import-route');

    INSERT INTO app.comparison_project_conflict_resolution (
      id,
      comparison_project_id,
      article_id,
      prompt_id,
      answer_value
    ) VALUES (
      'comparison-fk-conflict',
      'comparison-fk-project',
      'comparison-fk-article',
      'comparison-fk-prompt-1',
      'yes'
    );
  `)
}

test('patch updates comparison project while preserving conflict resolution children', async () => {
  if (!app || !database) {
    throw new Error('Test app not initialized')
  }

  await seedComparisonProjectFixture()

  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-fk-project', {
      body: JSON.stringify({
        allowConflictResolution: true,
        compareWithHumans: false,
        description: null,
        modelIds: ['comparison-fk-model-2'],
        name: 'Comparison FK Project Updated',
        promptSelections: [{promptId: 'comparison-fk-prompt-2', order: 0}],
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const bodyText = await response.text()

  if (response.status !== 200) {
    throw new Error(bodyText)
  }

  const [comparisonProject] = await database.queryJson<{modelIds: unknown; name: string}>(`
    SELECT name, model_ids AS modelIds
    FROM app.comparison_project
    WHERE id = 'comparison-fk-project'
  `)
  const promptLinks = await database.queryJson<{promptId: string}>(`
    SELECT prompt_id AS promptId
    FROM app.comparison_project_prompt
    WHERE comparison_project_id = 'comparison-fk-project'
  `)
  const routeLinks = await database.queryJson<{importRouteId: string}>(`
    SELECT import_route_id AS importRouteId
    FROM app.comparison_project_import_route
    WHERE comparison_project_id = 'comparison-fk-project'
  `)
  const conflictRows = await database.queryJson<{answerValue: string | null; promptId: string | null}>(`
    SELECT prompt_id AS promptId, answer_value AS answerValue
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = 'comparison-fk-project'
  `)

  expect(comparisonProject?.name).toBe('Comparison FK Project Updated')
  expect(comparisonProject?.modelIds).toEqual(['comparison-fk-model-2'])
  expect(promptLinks).toEqual([{promptId: 'comparison-fk-prompt-2'}])
  expect(routeLinks).toEqual([{importRouteId: 'comparison-fk-import-route'}])
  expect(conflictRows).toEqual([{answerValue: 'yes', promptId: 'comparison-fk-prompt-1'}])
})

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f2-admin-investigate-fk')

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

  const {adminInvestigateRoutes} = await import('./AdminInvestigateRoutes.ts')

  database = getAppDatabaseService()
  app = new Elysia().use(adminInvestigateRoutes)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('delete unexpected answers soft-deletes a judgment with an assessment', async () => {
  if (!app || !database) {
    throw new Error('Test app not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('admin-fk-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('admin-fk-model', 'admin-fk-connection', 'admin-fk-model', 'admin-fk-model', 'Admin FK Model', 'manual', TRUE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES ('admin-fk-prompt', 'Prompt', 'Prompt', '''yes'' | ''no''', 'admin-fk-prompt-hash');

    INSERT INTO app.article (id, article_title)
    VALUES ('admin-fk-article', 'Admin FK Article');

    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      is_answered,
      answered_original,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    ) VALUES (
      'admin-fk-judgment',
      'admin-fk-article',
      'admin-fk-prompt',
      'admin-fk-model',
      TRUE,
      'maybe',
      TRUE,
      TRUE,
      FALSE,
      FALSE
    );

    INSERT INTO app.judgment_assessment (id, judgment_id, assessment_is_correct, assessment_comment)
    VALUES ('admin-fk-assessment', 'admin-fk-judgment', FALSE, 'unexpected answer');
  `)

  const response = await app.handle(
    new Request('http://localhost/api/admin/delete-unexpected-answers', {
      body: JSON.stringify({projectId: null, promptId: 'admin-fk-prompt', unexpectedValue: 'maybe'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  if (response.status !== 200) {
    throw new Error(bodyText)
  }

  const result = JSON.parse(bodyText) as {deleted: number}
  const [judgment] = await database.queryJson<{assessmentCount: number; deletedAt: string | null}>(`
    SELECT
      deleted_at AS deletedAt,
      (
        SELECT CAST(COUNT(*) AS INTEGER)
        FROM app.judgment_assessment
        WHERE judgment_id = 'admin-fk-judgment'
      ) AS assessmentCount
    FROM app.judgment
    WHERE id = 'admin-fk-judgment'
  `)

  expect(result.deleted).toBe(1)
  expect(judgment?.deletedAt).not.toBeNull()
  expect(judgment?.assessmentCount).toBe(1)
})

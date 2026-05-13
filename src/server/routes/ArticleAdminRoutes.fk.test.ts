import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f2-article-admin-fk')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.FORSKA_DESKTOP_MODE = 'true'
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {articleAdminRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./ArticleAdminRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
  app = new Elysia().use(articleAdminRoutes)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

const seedReferencedArticleFixture = async (prefix: string) => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  const articleId = `${prefix}-article`
  const comparisonProjectId = `${prefix}-comparison-project`
  const connectionId = `${prefix}-connection`
  const importRouteId = `${prefix}-import-route`
  const modelId = `${prefix}-model`
  const projectId = `${prefix}-project`
  const promptId = `${prefix}-prompt`

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', '${modelId}', '${modelId}', '${modelId}', 'manual', TRUE);

    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', '${modelId}', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', '${promptId}', '${promptId}-hash');

    INSERT INTO app.import_route (id, route, name)
    VALUES ('${importRouteId}', '/${prefix}', '${prefix}');

    INSERT INTO app.article (id, article_title, full_text_pdf)
    VALUES ('${articleId}', '${articleId}', '${prefix}.pdf');

    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('${prefix}-article-route', '${articleId}', '${importRouteId}');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${prefix}-project-article', '${projectId}', '${articleId}');

    INSERT INTO app.review (id, project_id, article_id, opened)
    VALUES ('${prefix}-review', '${projectId}', '${articleId}', TRUE);

    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      project_id,
      is_answered,
      answered_original,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    ) VALUES (
      '${prefix}-judgment',
      '${articleId}',
      '${promptId}',
      '${modelId}',
      '${projectId}',
      TRUE,
      'yes',
      TRUE,
      TRUE,
      FALSE,
      FALSE
    );

    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES ('${prefix}-human-judgment', '${projectId}', '${articleId}', '${promptId}', TRUE, 'yes');

    INSERT INTO app.comparison_project (id, name, model_ids, compare_with_humans, human_judgment_mode)
    VALUES ('${comparisonProjectId}', '${comparisonProjectId}', ['${modelId}'], FALSE, 'prompt');

    INSERT INTO app.comparison_project_conflict_resolution (
      id,
      comparison_project_id,
      article_id,
      prompt_id,
      answer_value
    ) VALUES (
      '${prefix}-comparison-conflict',
      '${comparisonProjectId}',
      '${articleId}',
      '${promptId}',
      'yes'
    );

    INSERT INTO app.project_mart_refresh_article_state (project_id, article_id, first_dirty_token, last_dirty_token)
    VALUES ('${projectId}', '${articleId}', 1, 1);
  `)

  return {articleId}
}

test('article admin upload updates a referenced article', async () => {
  if (!app || !database) {
    throw new Error('Test app not initialized')
  }

  const {articleId} = await seedReferencedArticleFixture('article-admin-upload-fk')
  const formData = new FormData()
  formData.set('pdf', new File(['%PDF-1.4'], `${articleId}.pdf`, {type: 'application/pdf'}))

  const response = await app.handle(
    new Request(`http://localhost/api/articles/${articleId}/upload-pdf`, {body: formData, method: 'POST'}),
  )
  const bodyText = await response.text()

  if (response.status !== 200) {
    throw new Error(bodyText)
  }

  const [article] = await database.queryJson<{fullTextSource: string | null; status: string | null}>(`
    SELECT full_text_source AS fullTextSource, full_text_conversion_status AS status
    FROM app.article
    WHERE id = '${articleId}'
  `)

  expect(article).toEqual({fullTextSource: 'user_upload', status: null})
})

test('full text fetch update works on a referenced article', async () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  const {articleId} = await seedReferencedArticleFixture('full-text-fetch-fk')

  await database.run(`
    UPDATE app.article
    SET full_text_source = 'unpaywall',
        full_text_original_format = 'pdf',
        full_text_pdf = 'assets/full-text-fetch-fk.pdf',
        full_text_fetched_at = TIMESTAMPTZ '2026-05-13T00:00:00Z',
        updated_at = current_timestamp
    WHERE id = '${articleId}'
  `)

  const [article] = await database.queryJson<{fullTextPDF: string | null; fullTextSource: string | null}>(`
    SELECT full_text_pdf AS fullTextPDF, full_text_source AS fullTextSource
    FROM app.article
    WHERE id = '${articleId}'
  `)

  expect(article).toEqual({fullTextPDF: 'assets/full-text-fetch-fk.pdf', fullTextSource: 'unpaywall'})
})

test('full text conversion updates work on referenced articles', async () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  const successArticle = await seedReferencedArticleFixture('full-text-conversion-success-fk')
  const failureArticle = await seedReferencedArticleFixture('full-text-conversion-failure-fk')

  await database.run(`
    UPDATE app.article
    SET full_text = 'converted markdown',
        full_text_html = '<p>converted html</p>',
        full_text_conversion_status = 'success',
        full_text_conversion_error = NULL,
        full_text_conversion_model_id = 'conversion-model',
        full_text_conversion_metadata = {'modelId':'conversion-model'}::JSON,
        full_text_char_count = 18,
        full_text_conversion_attempts = 1,
        updated_at = current_timestamp
    WHERE id = '${successArticle.articleId}'
  `)
  await database.run(`
    UPDATE app.article
    SET full_text_conversion_status = 'failed',
        full_text_conversion_error = 'conversion failed',
        full_text_conversion_model_id = 'conversion-model',
        full_text_conversion_metadata = {'modelId':'conversion-model'}::JSON,
        full_text_conversion_attempts = 3,
        updated_at = current_timestamp
    WHERE id = '${failureArticle.articleId}'
  `)

  const articles = await database.queryJson<{id: string; status: string | null}>(`
    SELECT id, full_text_conversion_status AS status
    FROM app.article
    WHERE id IN ('${successArticle.articleId}', '${failureArticle.articleId}')
    ORDER BY id
  `)

  expect(articles).toEqual([
    {id: failureArticle.articleId, status: 'failed'},
    {id: successArticle.articleId, status: 'success'},
  ])
})

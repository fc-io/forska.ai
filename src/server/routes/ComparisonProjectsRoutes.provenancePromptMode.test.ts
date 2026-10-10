import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-provenance-prompt-mode')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const comparisonProjectId = 'prompt-mode-comparison'

type AppDatabase = ReturnType<typeof import('../services/appDatabaseService.ts').getAppDatabaseService>

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: AppDatabase | null = null

const getApp = () => {
  if (!app) {
    throw new Error('App not initialized')
  }

  return app
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  return database
}

const postJson = (path: string, body: unknown) => {
  return getApp().handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

const getListedArticleIds = async (conflictResolutionProvenanceFilter: string[]) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/judgments`, {
    conflictResolutionProvenanceFilter,
    limit: 50,
  })
  const body = (await response.json()) as {data: {data: Array<{canonicalArticleId: string}>}}

  expect(response.status).toBe(200)
  return body.data.data
    .map((row) => {
      return row.canonicalArticleId
    })
    .sort()
}

const seed = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('prompt-mode-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('prompt-mode-model', 'prompt-mode-connection', 'gpt-5.5', 'prompt-mode-model', 'GPT 5.5', 'manual', TRUE);
    INSERT INTO app.project (id, name, description, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('prompt-mode-source', 'Prompt mode source', NULL, 'prompt-mode-model', TRUE, TRUE, FALSE, FALSE),
      ('prompt-mode-humans', 'Prompt mode humans', NULL, 'prompt-mode-model', TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('prompt-mode-population', 'Population text', 'Population', NULL, 'prompt-mode-population-hash'),
      ('prompt-mode-outcome', 'Outcome text', 'Outcome', NULL, 'prompt-mode-outcome-hash');
    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('prompt-mode-article-1', 'external-1', 'Prompt mode article one', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z'),
      ('prompt-mode-article-2', 'external-2', 'Prompt mode article two', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z');
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('prompt-mode-source-article-1', 'prompt-mode-source', 'prompt-mode-article-1'),
      ('prompt-mode-source-article-2', 'prompt-mode-source', 'prompt-mode-article-2');
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('prompt-mode-j-1-population', 'prompt-mode-article-1', 'prompt-mode-population', 'prompt-mode-model', 'prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('prompt-mode-j-1-outcome', 'prompt-mode-article-1', 'prompt-mode-outcome', 'prompt-mode-model', 'prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('prompt-mode-j-2-population', 'prompt-mode-article-2', 'prompt-mode-population', 'prompt-mode-model', 'prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('prompt-mode-j-2-outcome', 'prompt-mode-article-2', 'prompt-mode-outcome', 'prompt-mode-model', 'prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      ('prompt-mode-h-1-population', 'prompt-mode-humans', 'prompt-mode-article-1', 'prompt-mode-population', TRUE, 'no'),
      ('prompt-mode-h-1-outcome', 'prompt-mode-humans', 'prompt-mode-article-1', 'prompt-mode-outcome', TRUE, 'yes'),
      ('prompt-mode-h-2-population', 'prompt-mode-humans', 'prompt-mode-article-2', 'prompt-mode-population', TRUE, 'no'),
      ('prompt-mode-h-2-outcome', 'prompt-mode-humans', 'prompt-mode-article-2', 'prompt-mode-outcome', TRUE, 'yes');
    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES ('${comparisonProjectId}', 'Prompt mode', NULL, ['prompt-mode-model'], TRUE, TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES
      ('prompt-mode-cp-population', '${comparisonProjectId}', 'prompt-mode-population', 0),
      ('prompt-mode-cp-outcome', '${comparisonProjectId}', 'prompt-mode-outcome', 1);
    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES ('prompt-mode-cp-source', '${comparisonProjectId}', 'prompt-mode-source');
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {comparisonProjectsRoutes}, rebuildModule] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ComparisonProjectsRoutes.ts'),
    import('../services/comparisonProjectServingRebuildService.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
  await seed()
  await rebuildModule.getComparisonProjectServingRebuildService().rebuildComparisonProjectServing(comparisonProjectId)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('prompt mode: the activated generation records one LLM and one human column per prompt', async () => {
  const response = await getApp().handle(new Request(`http://localhost/api/comparison-projects/${comparisonProjectId}`))
  const body = (await response.json()) as {
    data: {
      judgmentContext: {context: {columns: Array<Record<string, unknown>>; humanJudgmentMode: string}} | null
      judgmentContextId: string | null
    }
  }
  const llmSettings = {
    contentKey: '1100',
    kind: 'llm',
    modelId: 'prompt-mode-model',
    modelName: 'gpt-5.5',
    sourceProjectId: null,
    systemPromptVariant: 'legacy',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
  }

  expect(response.status).toBe(200)
  expect(body.data.judgmentContextId).toMatch(/^[0-9a-f]{64}$/)
  expect(body.data.judgmentContext?.context.humanJudgmentMode).toBe('prompt')
  expect(body.data.judgmentContext?.context.columns).toEqual([
    {kind: 'human', promptHeading: 'Outcome', promptId: 'prompt-mode-outcome'},
    {kind: 'human', promptHeading: 'Population', promptId: 'prompt-mode-population'},
    {...llmSettings, promptHeading: 'Outcome', promptId: 'prompt-mode-outcome'},
    {...llmSettings, promptHeading: 'Population', promptId: 'prompt-mode-population'},
  ])
})

test('prompt mode: a UI save stores the winning prompt with provenance and filters as current', async () => {
  const detail = (await (
    await getApp().handle(new Request(`http://localhost/api/comparison-projects/${comparisonProjectId}`))
  ).json()) as {data: {judgmentContextId: string}}
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId: 'prompt-mode-article-1',
    value: 'prompt-mode-population',
  })
  const body = (await response.json()) as {
    data: {provenance: {contextId: string | null; origin: string}; provenanceMatchesCurrent: boolean; setAt: string}
  }
  const [row] = await getDatabase().queryJson<{
    answerValue: string | null
    judgmentContextId: string | null
    origin: string | null
    promptId: string | null
    servingGeneration: string | null
  }>(`
    SELECT
      prompt_id AS promptId,
      answer_value AS answerValue,
      judgment_context_id AS judgmentContextId,
      origin,
      CAST(serving_generation AS VARCHAR) AS servingGeneration
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
  `)

  expect(response.status).toBe(200)
  expect(body.data.provenance).toMatchObject({contextId: detail.data.judgmentContextId, origin: 'ui'})
  expect(body.data.provenanceMatchesCurrent).toBe(true)
  expect(Number.isNaN(Date.parse(body.data.setAt))).toBe(false)
  expect(row).toEqual({
    answerValue: null,
    judgmentContextId: detail.data.judgmentContextId,
    origin: 'ui',
    promptId: 'prompt-mode-population',
    servingGeneration: '1',
  })
  expect(await getListedArticleIds(['current'])).toEqual(['prompt-mode-article-1'])
  expect(await getListedArticleIds(['outdated', 'unknown'])).toEqual([])
})

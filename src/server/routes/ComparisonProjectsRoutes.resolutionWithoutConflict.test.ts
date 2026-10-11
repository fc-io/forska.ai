import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-resolution-without-conflict')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const targetComparisonProjectId = 'no-conflict-comparison-target'
const sourceComparisonProjectId = 'no-conflict-comparison-source'

type ListedResolution = {label: string; provenance: {origin: string | null} | null; value: string}

type ListedRow = {canonicalArticleId: string; conflictResolution: ListedResolution | null; hasConflict: boolean}

type ResolutionRow = {answerValue: string | null; articleId: string; origin: string | null}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

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

const postResolution = async (comparisonProjectId: string, articleId: string, value: string) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId,
    value,
  })
  const text = await response.text()

  return {
    body: (response.ok ? JSON.parse(text) : {data: null, error: text}) as {
      data: ListedResolution | null
      error?: string
    },
    status: response.status,
  }
}

const postReset = async (comparisonProjectId: string, articleId: string) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution/reset`, {
    articleId,
  })

  return {status: response.status, text: await response.text()}
}

const getResolutionRows = (comparisonProjectId: string) => {
  return getDatabase().queryJson<ResolutionRow>(`
    SELECT article_id AS articleId, answer_value AS answerValue, origin
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
    ORDER BY article_id ASC
  `)
}

const getListedRows = async (comparisonProjectId: string, filters: Record<string, unknown> = {}) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/judgments`, {limit: 50, ...filters})
  const body = (await response.json()) as {data: {data: ListedRow[]}}

  expect(response.status).toBe(200)
  return body.data.data
}

const getListedArticleIds = async (filters: Record<string, unknown>) => {
  const rows = await getListedRows(targetComparisonProjectId, filters)

  return rows.map((row) => {
    return row.canonicalArticleId
  })
}

const getListedCount = async (filters: Record<string, unknown>) => {
  const response = await postJson(`/api/comparison-projects/${targetComparisonProjectId}/judgments/count`, {
    limit: 50,
    ...filters,
  })
  const body = (await response.json()) as {data: {totalCount: number}}

  expect(response.status).toBe(200)
  return body.data.totalCount
}

const getExportText = async (body: Record<string, unknown>) => {
  const response = await postJson(`/api/comparison-projects/${targetComparisonProjectId}/export`, body)

  expect(response.status).toBe(200)
  return Buffer.from(await response.arrayBuffer()).toString('latin1')
}

const getCsvBody = (csvText: string) => {
  return csvText.slice(csvText.indexOf('Title'))
}

const seedComparisonProjects = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('no-conflict-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('no-conflict-model-target', 'no-conflict-connection', 'target-model', 'no-conflict-model-target', 'Target model', 'manual', TRUE),
      ('no-conflict-model-source', 'no-conflict-connection', 'source-model', 'no-conflict-model-source', 'Source model', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('no-conflict-project', 'No conflict project', NULL, 'no-conflict-model-target', 'summary', TRUE, TRUE, FALSE, FALSE),
      ('no-conflict-source-project', 'No conflict source project', NULL, 'no-conflict-model-source', 'summary', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('no-conflict-include', 'Population text', 'Population', '''yes'' | ''no'' | ''maybe''', 'no-conflict-include-hash'),
      ('no-conflict-exclude', 'Exclusion text', 'Exclusion', '''yes'' | ''no'' | ''maybe''', 'no-conflict-exclude-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('no-conflict-project-include', 'no-conflict-project', 'no-conflict-include', 0, TRUE, 'include', 'population', 'Population'),
      ('no-conflict-project-exclude', 'no-conflict-project', 'no-conflict-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion'),
      ('no-conflict-source-include', 'no-conflict-source-project', 'no-conflict-include', 0, TRUE, 'include', 'population', 'Population'),
      ('no-conflict-source-exclude', 'no-conflict-source-project', 'no-conflict-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('no-conflict-article-1', 'external-1', 'Open conflict article', 'Summary one', TIMESTAMPTZ '2026-10-03T00:00:00Z'),
      ('no-conflict-article-2', 'external-2', 'Agreed but resolved article', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z'),
      ('no-conflict-article-3', 'external-3', 'Agreed article', 'Summary three', TIMESTAMPTZ '2026-10-01T00:00:00Z');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('no-conflict-project-article-1', 'no-conflict-project', 'no-conflict-article-1'),
      ('no-conflict-project-article-2', 'no-conflict-project', 'no-conflict-article-2'),
      ('no-conflict-project-article-3', 'no-conflict-project', 'no-conflict-article-3'),
      ('no-conflict-source-article-1', 'no-conflict-source-project', 'no-conflict-article-1'),
      ('no-conflict-source-article-2', 'no-conflict-source-project', 'no-conflict-article-2'),
      ('no-conflict-source-article-3', 'no-conflict-source-project', 'no-conflict-article-3');

    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('nc-t-1-include', 'no-conflict-article-1', 'no-conflict-include', 'no-conflict-model-target', 'no-conflict-project', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('nc-t-1-exclude', 'no-conflict-article-1', 'no-conflict-exclude', 'no-conflict-model-target', 'no-conflict-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('nc-t-2-include', 'no-conflict-article-2', 'no-conflict-include', 'no-conflict-model-target', 'no-conflict-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('nc-t-2-exclude', 'no-conflict-article-2', 'no-conflict-exclude', 'no-conflict-model-target', 'no-conflict-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('nc-t-3-include', 'no-conflict-article-3', 'no-conflict-include', 'no-conflict-model-target', 'no-conflict-project', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('nc-t-3-exclude', 'no-conflict-article-3', 'no-conflict-exclude', 'no-conflict-model-target', 'no-conflict-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('nc-s-1-include', 'no-conflict-article-1', 'no-conflict-include', 'no-conflict-model-source', 'no-conflict-source-project', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('nc-s-1-exclude', 'no-conflict-article-1', 'no-conflict-exclude', 'no-conflict-model-source', 'no-conflict-source-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('nc-s-2-include', 'no-conflict-article-2', 'no-conflict-include', 'no-conflict-model-source', 'no-conflict-source-project', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('nc-s-2-exclude', 'no-conflict-article-2', 'no-conflict-exclude', 'no-conflict-model-source', 'no-conflict-source-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('nc-s-3-include', 'no-conflict-article-3', 'no-conflict-include', 'no-conflict-model-source', 'no-conflict-source-project', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('nc-s-3-exclude', 'no-conflict-article-3', 'no-conflict-exclude', 'no-conflict-model-source', 'no-conflict-source-project', TRUE, 'no', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES
      ('nc-h-1', 'no-conflict-project', 'no-conflict-article-1', 'no', 'manual_override'),
      ('nc-h-2', 'no-conflict-project', 'no-conflict-article-2', 'no', 'manual_override'),
      ('nc-h-3', 'no-conflict-project', 'no-conflict-article-3', 'yes', 'manual_override'),
      ('nc-sh-1', 'no-conflict-source-project', 'no-conflict-article-1', 'no', 'manual_override'),
      ('nc-sh-2', 'no-conflict-source-project', 'no-conflict-article-2', 'no', 'manual_override'),
      ('nc-sh-3', 'no-conflict-source-project', 'no-conflict-article-3', 'yes', 'manual_override');

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('${targetComparisonProjectId}', 'No conflict target', NULL, ['no-conflict-model-target'], TRUE, TRUE, 'summary', 'no-conflict-project', TRUE, TRUE, FALSE, FALSE),
      ('${sourceComparisonProjectId}', 'No conflict source', NULL, ['no-conflict-model-source'], TRUE, TRUE, 'summary', 'no-conflict-source-project', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('nc-target-include', '${targetComparisonProjectId}', 'no-conflict-include', 0, 'include', 'population', 'Population'),
      ('nc-target-exclude', '${targetComparisonProjectId}', 'no-conflict-exclude', 1, 'exclude', 'exclusion', 'Exclusion'),
      ('nc-source-include', '${sourceComparisonProjectId}', 'no-conflict-include', 0, 'include', 'population', 'Population'),
      ('nc-source-exclude', '${sourceComparisonProjectId}', 'no-conflict-exclude', 1, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('nc-target-source', '${targetComparisonProjectId}', 'no-conflict-project'),
      ('nc-source-source', '${sourceComparisonProjectId}', 'no-conflict-source-project');
  `)
}

const importSourceResolutionsIntoTarget = async () => {
  const exportResponse = await postJson(
    `/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`,
    {},
  )
  const artifact: unknown = await exportResponse.json()
  const importResponse = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact, importMode: 'all-matched', overwriteMode: 'skip-existing'},
  )

  expect(exportResponse.status).toBe(200)
  expect(importResponse.status).toBe(200)
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
  await seedComparisonProjects()
  await rebuildModule
    .getComparisonProjectServingRebuildService()
    .rebuildComparisonProjectServing(targetComparisonProjectId)
  await rebuildModule
    .getComparisonProjectServingRebuildService()
    .rebuildComparisonProjectServing(sourceComparisonProjectId)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('an imported resolution on a row without a current conflict is listed, filtered and exported', async () => {
  const sourceSave = await postResolution(sourceComparisonProjectId, 'no-conflict-article-2', 'yes')

  expect(sourceSave.status).toBe(200)
  await importSourceResolutionsIntoTarget()

  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([
    {answerValue: 'yes', articleId: 'no-conflict-article-2', origin: 'file-import'},
  ])
  expect(
    (await getListedRows(targetComparisonProjectId)).map((row) => {
      return [row.canonicalArticleId, row.hasConflict, row.conflictResolution?.value ?? null]
    }),
  ).toEqual([
    ['no-conflict-article-1', true, null],
    ['no-conflict-article-2', false, 'yes'],
    ['no-conflict-article-3', false, null],
  ])
  expect(await getListedArticleIds({conflictResolutionFilter: ['yes']})).toEqual(['no-conflict-article-2'])
  expect(await getListedCount({conflictResolutionFilter: ['yes']})).toBe(1)
  expect(await getListedArticleIds({conflictResolutionFilter: ['not-set']})).toEqual(['no-conflict-article-1'])
  expect(await getListedArticleIds({conflictResolutionFilter: ['not-set', 'yes']})).toEqual([
    'no-conflict-article-1',
    'no-conflict-article-2',
  ])
  expect(await getListedArticleIds({differenceFilter: ['resolution-vs-llm']})).toEqual(['no-conflict-article-2'])
  expect(await getListedArticleIds({differenceFilter: ['resolution-vs-human']})).toEqual(['no-conflict-article-2'])
  expect(await getListedCount({differenceFilter: ['resolution-vs-human']})).toBe(1)
  expect(await getListedArticleIds({conflictResolutionProvenanceFilter: ['outdated', 'unknown']})).toEqual([
    'no-conflict-article-2',
  ])

  const csv = getCsvBody(await getExportText({format: 'csv'}))
  const filteredCsv = getCsvBody(await getExportText({conflictResolutionFilter: ['yes'], format: 'csv'}))

  expect(csv).toContain('Open conflict article,Summary one,2026-10-03T00:00:00.000Z,,,yes,no')
  expect(csv).toContain('Agreed but resolved article,Summary two,2026-10-02T00:00:00.000Z,yes,,no,no')
  expect(csv).toContain('Agreed article,Summary three,2026-10-01T00:00:00.000Z,No conflict,,yes,yes')
  expect(filteredCsv).toContain('Agreed but resolved article')
  expect(filteredCsv).not.toContain('Open conflict article')

  const pdf = await getExportText({format: 'pdf'})

  expect(pdf).toContain('no-conflict-article-2.resolution')
  expect(pdf).toContain('no current conflict')
  expect(pdf).not.toContain('no-conflict-article-3.resolution')
})

test('a stored resolution without a current conflict can be changed and cleared, but not created', async () => {
  const changed = await postResolution(targetComparisonProjectId, 'no-conflict-article-2', 'no')

  expect(changed.status).toBe(200)
  expect(changed.body.data).toMatchObject({label: 'no', provenance: {origin: 'ui'}, value: 'no'})
  expect(await getListedArticleIds({conflictResolutionFilter: ['no']})).toEqual(['no-conflict-article-2'])

  const createdOnAgreedRow = await postResolution(targetComparisonProjectId, 'no-conflict-article-3', 'no')

  expect(createdOnAgreedRow.status).toBe(400)
  expect(createdOnAgreedRow.body.error).toContain('only available for conflicting articles')

  const reset = await postReset(targetComparisonProjectId, 'no-conflict-article-2')

  expect(reset.status).toBe(200)
  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([])

  const recreated = await postResolution(targetComparisonProjectId, 'no-conflict-article-2', 'yes')
  const resetWithoutResolution = await postReset(targetComparisonProjectId, 'no-conflict-article-3')
  const resolvedConflict = await postResolution(targetComparisonProjectId, 'no-conflict-article-1', 'maybe')

  expect(recreated.status).toBe(400)
  expect(resetWithoutResolution.status).toBe(400)
  expect(resolvedConflict.status).toBe(200)
  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([
    {answerValue: 'maybe', articleId: 'no-conflict-article-1', origin: 'ui'},
  ])
})

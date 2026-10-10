import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-provenance-lifecycle')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const comparisonProjectId = 'lifecycle-comparison'
const includePromptId = 'lifecycle-include'
const excludePromptId = 'lifecycle-exclude'
const missingContextId = 'e'.repeat(64)

type Runner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type AppDatabase = ReturnType<typeof import('../services/appDatabaseService.ts').getAppDatabaseService>

type ResolutionView = {
  provenance: {contextId: string | null; generation: number | null; origin: string | null} | null
  provenanceMatchesCurrent: boolean | null
  reviewer: {displayName: string | null; userId: string} | null
  setAt: string | null
  value: string
}

type StatsComparison = {kind: string; overlapCount: number}

type StatsBody = {
  data: {
    additionalProjectStats: {resolvedTruthComparisons: Array<{resolvedCount: number}>}
    comparisons: StatsComparison[]
    conflictResolutionProvenance: string
    conflictResolutionProvenanceScope: {applied: boolean; reason: string | null; requested: string}
  }
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: AppDatabase | null = null
let rebuildService: ReturnType<
  typeof import('../services/comparisonProjectServingRebuildService.ts').getComparisonProjectServingRebuildService
> | null = null
let cellBuilder: ReturnType<
  typeof import('../services/comparisonProjectServingCellBuilder.ts').getComparisonProjectServingCellBuilder
> | null = null
let backfillModule: typeof import('../services/comparisonJudgmentContextBackfill.ts') | null = null
const contextIdsByGeneration = new Map<number, string>()

const getInitialized = <T>(value: T | null, name: string): T => {
  if (value === null) {
    throw new Error(`${name} not initialized`)
  }

  return value
}

const getDatabase = () => {
  return getInitialized(database, 'Database')
}

const postJson = (path: string, body: unknown) => {
  return getInitialized(app, 'App').handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

const getJson = async <T>(path: string) => {
  const response = await getInitialized(app, 'App').handle(new Request(`http://localhost${path}`))

  expect(response.status).toBe(200)
  return (await response.json()) as T
}

const getBackgroundRunner = (): Runner & {
  transaction: <T>(operation: (runner: Runner) => Promise<T>) => Promise<T>
} => {
  return {
    queryJson: (statement) => {
      return getDatabase().queryJsonBackground(statement)
    },
    run: (statement) => {
      return getDatabase().runBackground(statement)
    },
    transaction: (operation) => {
      return getDatabase().transaction(operation)
    },
  }
}

const getActiveGeneration = async () => {
  const [row] = await getDatabase().queryJson<{generation: number}>(`
    SELECT CAST(active_generation AS INTEGER) AS generation
    FROM app.comparison_project_serving_generation
    WHERE comparison_project_id = '${comparisonProjectId}'
  `)

  return row?.generation ?? 0
}

const getContextIdForGeneration = async (generation: number) => {
  const [row] = await getDatabase().queryJson<{judgmentContextId: string}>(`
    SELECT judgment_context_id AS judgmentContextId
    FROM mart.comparison_judgment_context_serving
    WHERE comparison_project_id = '${comparisonProjectId}'
      AND generation = ${generation}
  `)

  return row?.judgmentContextId ?? null
}

const getContextCriteriaPromptIds = async (judgmentContextId: string) => {
  const [row] = await getDatabase().queryJson<{contextJson: string}>(`
    SELECT CAST(context_json AS VARCHAR) AS contextJson
    FROM app.comparison_judgment_context
    WHERE id = '${judgmentContextId}'
  `)
  const context = JSON.parse(row?.contextJson ?? '{"columns":[]}') as {
    columns: Array<{criteria?: Array<{promptId: string}>}>
  }

  return context.columns.flatMap((column) => {
    return (column.criteria ?? []).map((criterion) => {
      return criterion.promptId
    })
  })
}

const rebuild = async (
  overrides: Parameters<NonNullable<typeof rebuildService>['rebuildComparisonProjectServing']>[1] = {},
) => {
  await getInitialized(rebuildService, 'Rebuild service').rebuildComparisonProjectServing(
    comparisonProjectId,
    overrides,
  )
  const generation = await getActiveGeneration()
  const judgmentContextId = await getContextIdForGeneration(generation)

  if (judgmentContextId) {
    contextIdsByGeneration.set(generation, judgmentContextId)
  }

  return {generation, judgmentContextId}
}

const saveResolution = async (articleId: string, value: string) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId,
    value,
  })

  expect(response.status).toBe(200)
  return ((await response.json()) as {data: ResolutionView}).data
}

const getResolutionsByArticle = async () => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/judgments`, {limit: 50})
  const body = (await response.json()) as {
    data: {data: Array<{canonicalArticleId: string; conflictResolution: ResolutionView | null}>}
  }

  expect(response.status).toBe(200)
  return new Map(
    body.data.data.map((row) => {
      return [row.canonicalArticleId, row.conflictResolution] as const
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

const getStats = (conflictResolutionProvenance: 'all' | 'current') => {
  return getJson<StatsBody>(
    `/api/comparison-projects/${comparisonProjectId}/stats?conflictResolutionProvenance=${conflictResolutionProvenance}`,
  )
}

const getOverlapCount = (stats: StatsBody, kind: string) => {
  return stats.data.comparisons.find((comparison) => {
    return comparison.kind === kind
  })?.overlapCount
}

const seed = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('lifecycle-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('lifecycle-model', 'lifecycle-connection', 'gpt-5.5', 'lifecycle-model', 'GPT 5.5', 'manual', TRUE);
    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('lifecycle-source', 'Lifecycle source', NULL, 'lifecycle-model', 'summary', TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('${includePromptId}', 'Population text', 'Population', '''yes'' | ''no'' | ''maybe''', 'lifecycle-include-hash'),
      ('${excludePromptId}', 'Exclusion text', 'Exclusion', '''yes'' | ''no'' | ''maybe''', 'lifecycle-exclude-hash');
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('lifecycle-source-include', 'lifecycle-source', '${includePromptId}', 0, TRUE, 'include', 'population', 'Population'),
      ('lifecycle-source-exclude', 'lifecycle-source', '${excludePromptId}', 1, TRUE, 'exclude', 'exclusion', 'Exclusion');
    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('lifecycle-article-1', 'external-1', 'Lifecycle article one', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z'),
      ('lifecycle-article-2', 'external-2', 'Lifecycle article two', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z'),
      ('lifecycle-article-3', 'external-3', 'Lifecycle article three', 'Summary three', TIMESTAMPTZ '2026-10-03T00:00:00Z');
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('lifecycle-source-article-1', 'lifecycle-source', 'lifecycle-article-1'),
      ('lifecycle-source-article-2', 'lifecycle-source', 'lifecycle-article-2'),
      ('lifecycle-source-article-3', 'lifecycle-source', 'lifecycle-article-3');
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    SELECT
      'lifecycle-j-' || article.id || '-' || prompt.id,
      article.id,
      prompt.id,
      'lifecycle-model',
      'lifecycle-source',
      TRUE,
      CASE WHEN prompt.id = '${includePromptId}' THEN 'yes' ELSE 'no' END,
      TRUE, TRUE, FALSE, FALSE
    FROM app.article article
    CROSS JOIN app.prompt prompt
    WHERE article.id LIKE 'lifecycle-article-%' AND prompt.id LIKE 'lifecycle-%';
    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES
      ('lifecycle-h-1', 'lifecycle-source', 'lifecycle-article-1', 'no', 'manual_override'),
      ('lifecycle-h-2', 'lifecycle-source', 'lifecycle-article-2', 'no', 'manual_override'),
      ('lifecycle-h-3', 'lifecycle-source', 'lifecycle-article-3', 'yes', 'manual_override');
    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES ('${comparisonProjectId}', 'Lifecycle', NULL, ['lifecycle-model'], TRUE, TRUE, 'summary', 'lifecycle-source', TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('lifecycle-cp-include', '${comparisonProjectId}', '${includePromptId}', 0, 'include', 'population', 'Population'),
      ('lifecycle-cp-exclude', '${comparisonProjectId}', '${excludePromptId}', 1, 'exclude', 'exclusion', 'Exclusion');
    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES ('lifecycle-cp-source', '${comparisonProjectId}', 'lifecycle-source');
  `)
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {comparisonProjectsRoutes},
    rebuildModule,
    cellBuilderModule,
    backfill,
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ComparisonProjectsRoutes.ts'),
    import('../services/comparisonProjectServingRebuildService.ts'),
    import('../services/comparisonProjectServingCellBuilder.ts'),
    import('../services/comparisonJudgmentContextBackfill.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
  rebuildService = rebuildModule.getComparisonProjectServingRebuildService()
  cellBuilder = cellBuilderModule.getComparisonProjectServingCellBuilder()
  backfillModule = backfill
  await seed()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('a criteria edit during a rebuild leaves the promoted generation with its own snapshot context', async () => {
  const first = await rebuild()

  await saveResolution('lifecycle-article-1', 'yes')
  await saveResolution('lifecycle-article-2', 'yes')

  const realCellBuilder = getInitialized(cellBuilder, 'Cell builder')
  const editedMidRebuild = await rebuild({
    cellBuilder: {
      ...realCellBuilder,
      insertSummaryModeComparisonProjectCells: async (params, runner) => {
        await realCellBuilder.insertSummaryModeComparisonProjectCells(params, runner)
        await getDatabase().run(`UPDATE app.project_prompt SET enabled = FALSE WHERE id = 'lifecycle-source-exclude'`)
      },
    },
  })
  const afterEdit = await rebuild()

  expect(first.judgmentContextId).toMatch(/^[0-9a-f]{64}$/)
  expect(editedMidRebuild.generation).toBe(first.generation + 1)
  expect(editedMidRebuild.judgmentContextId).toBe(first.judgmentContextId)
  expect(await getContextCriteriaPromptIds(editedMidRebuild.judgmentContextId ?? '')).toEqual([
    excludePromptId,
    includePromptId,
  ])
  expect(afterEdit.generation).toBe(first.generation + 2)
  expect(afterEdit.judgmentContextId).not.toBe(first.judgmentContextId)
  expect(await getContextCriteriaPromptIds(afterEdit.judgmentContextId ?? '')).toEqual([includePromptId])
})

test('resolutions saved under an older generation read as outdated after the criteria changed', async () => {
  const before = await getResolutionsByArticle()
  const resaved = await saveResolution('lifecycle-article-2', 'yes')
  const after = await getResolutionsByArticle()
  const currentContextId = contextIdsByGeneration.get(await getActiveGeneration())

  expect(before.get('lifecycle-article-1')).toMatchObject({
    provenance: {contextId: contextIdsByGeneration.get(1), generation: 1, origin: 'ui'},
    provenanceMatchesCurrent: false,
  })
  expect(Number.isNaN(Date.parse(before.get('lifecycle-article-1')?.setAt ?? ''))).toBe(false)
  expect(resaved).toMatchObject({
    provenance: {contextId: currentContextId, generation: 3},
    provenanceMatchesCurrent: true,
  })
  expect(after.get('lifecycle-article-2')).toMatchObject({provenanceMatchesCurrent: true})
  expect(await getListedArticleIds(['outdated'])).toEqual(['lifecycle-article-1'])
  expect(await getListedArticleIds(['current'])).toEqual(['lifecycle-article-2'])
  expect(await getListedArticleIds(['unknown'])).toEqual([])
})

test('current-context stats drop articles resolved under other contexts from every resolution comparison', async () => {
  const allStats = await getStats('all')
  const currentStats = await getStats('current')

  expect(currentStats.data.conflictResolutionProvenanceScope).toEqual({
    applied: true,
    reason: null,
    requested: 'current',
  })
  expect(allStats.data.conflictResolutionProvenanceScope).toEqual({applied: true, reason: null, requested: 'all'})
  expect(getOverlapCount(allStats, 'llm-vs-conflict-resolution')).toBe(3)
  expect(getOverlapCount(currentStats, 'llm-vs-conflict-resolution')).toBe(2)
  expect(getOverlapCount(allStats, 'llm-vs-conflict-resolution-no-fallback')).toBe(2)
  expect(getOverlapCount(currentStats, 'llm-vs-conflict-resolution-no-fallback')).toBe(1)
  expect(getOverlapCount(currentStats, 'human-vs-llm')).toBe(getOverlapCount(allStats, 'human-vs-llm'))
  expect(allStats.data.additionalProjectStats.resolvedTruthComparisons[0]?.resolvedCount).toBe(2)
  expect(currentStats.data.additionalProjectStats.resolvedTruthComparisons[0]?.resolvedCount).toBe(1)
})

test('the export filters keep only resolutions with the requested provenance', async () => {
  const outdatedArtifact = (await (
    await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolutions/export`, {
      conflictResolutionProvenanceFilter: ['outdated'],
    })
  ).json()) as {rows: Array<{sourceArticleRowId: string}>}
  const currentArtifact = (await (
    await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolutions/export`, {
      conflictResolutionProvenanceFilter: 'current',
    })
  ).json()) as {rows: Array<{sourceArticleRowId: string}>}
  const csvResponse = await postJson(`/api/comparison-projects/${comparisonProjectId}/export`, {
    conflictResolutionProvenanceFilter: ['outdated'],
    format: 'csv',
  })
  const csv = await csvResponse.text()

  expect(
    outdatedArtifact.rows.map((row) => {
      return row.sourceArticleRowId
    }),
  ).toEqual(['lifecycle-article-1'])
  expect(
    currentArtifact.rows.map((row) => {
      return row.sourceArticleRowId
    }),
  ).toEqual(['lifecycle-article-2'])
  expect(csvResponse.status).toBe(200)
  expect(csv).toContain('Lifecycle article one')
  expect(csv).not.toContain('Lifecycle article two')
  expect(csv).not.toContain('Lifecycle article three')
})

test('a context id with no local row and a pre-feature row both stay readable', async () => {
  await getDatabase().run(`
    UPDATE app.comparison_project_conflict_resolution
    SET judgment_context_id = '${missingContextId}'
    WHERE comparison_project_id = '${comparisonProjectId}' AND article_id = 'lifecycle-article-1'
  `)
  const withMissingContext = (await getResolutionsByArticle()).get('lifecycle-article-1')
  const lookupResponse = await postJson('/api/comparison-projects/judgment-contexts', {ids: [missingContextId]})

  await getDatabase().run(`
    UPDATE app.comparison_project_conflict_resolution
    SET judgment_context_id = NULL, serving_generation = NULL, origin = NULL, origin_ref = NULL,
      reviewer_user_id = NULL, reviewer_display_name = NULL, updated_at = TIMESTAMPTZ '2026-09-01T08:00:00Z'
    WHERE comparison_project_id = '${comparisonProjectId}' AND article_id = 'lifecycle-article-1'
  `)
  const legacy = (await getResolutionsByArticle()).get('lifecycle-article-1')

  expect(withMissingContext).toMatchObject({
    provenance: {contextId: missingContextId, generation: 1, origin: 'ui'},
    provenanceMatchesCurrent: false,
  })
  expect(((await lookupResponse.json()) as {data: unknown[]}).data).toEqual([])
  expect(legacy).toMatchObject({
    provenance: null,
    provenanceMatchesCurrent: null,
    reviewer: null,
    setAt: '2026-09-01T08:00:00.000Z',
    value: 'yes',
  })
  expect(await getListedArticleIds(['unknown'])).toEqual(['lifecycle-article-1'])
})

test('without an active context, current stats are not applied and say so', async () => {
  const generation = await getActiveGeneration()

  await getDatabase().run(`
    DELETE FROM mart.comparison_judgment_context_serving
    WHERE comparison_project_id = '${comparisonProjectId}' AND generation = ${generation}
  `)
  const allStats = await getStats('all')
  const currentStats = await getStats('current')
  const detail = await getJson<{data: {judgmentContext: unknown; judgmentContextId: string | null}}>(
    `/api/comparison-projects/${comparisonProjectId}`,
  )

  expect(detail.data).toMatchObject({judgmentContext: null, judgmentContextId: null})
  expect(currentStats.data.conflictResolutionProvenance).toBe('current')
  expect(currentStats.data.conflictResolutionProvenanceScope).toEqual({
    applied: false,
    reason: 'no-active-context',
    requested: 'current',
  })
  expect(currentStats.data.comparisons).toEqual(allStats.data.comparisons)
  expect(currentStats.data.additionalProjectStats).toEqual(allStats.data.additionalProjectStats)

  const backfill = getInitialized(backfillModule, 'Backfill')
  const result = await backfill.backfillNextComparisonJudgmentContext(getBackgroundRunner(), {
    state: backfill.createComparisonJudgmentContextBackfillState(),
  })

  expect(result).toEqual({
    comparisonProjectId,
    generation,
    judgmentContextId: contextIdsByGeneration.get(generation) ?? '',
    status: 'written',
  })
})

test('a failing context write never blocks promotion and the backfill fills the row later', async () => {
  const runner = getBackgroundRunner()
  const failingDatabase = {
    ...runner,
    run: async (statement: string) => {
      if (statement.includes('INSERT INTO app.comparison_judgment_context')) {
        throw new Error('simulated context write failure')
      }

      return runner.run(statement)
    },
  }
  const previousGeneration = await getActiveGeneration()
  const originalWarn = console.warn
  console.warn = () => {}

  const failed = await rebuild({database: failingDatabase}).finally(() => {
    console.warn = originalWarn
  })
  const saved = await saveResolution('lifecycle-article-2', 'no')
  const backfill = getInitialized(backfillModule, 'Backfill')
  const result = await backfill.backfillNextComparisonJudgmentContext(runner, {
    state: backfill.createComparisonJudgmentContextBackfillState(),
  })

  expect(failed).toEqual({generation: previousGeneration + 1, judgmentContextId: null})
  expect(saved).toMatchObject({provenance: {contextId: null, generation: previousGeneration + 1, origin: 'ui'}})
  expect(saved.provenanceMatchesCurrent).toBeNull()
  expect(result).toEqual({
    comparisonProjectId,
    generation: previousGeneration + 1,
    judgmentContextId: contextIdsByGeneration.get(previousGeneration) ?? '',
    status: 'written',
  })
})

test('imports cap reviewer names and reject oversized judgment contexts', async () => {
  const artifact = (await (
    await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolutions/export`, {})
  ).json()) as {rows: Array<Record<string, unknown> & {provenance?: Record<string, unknown> | null}>}
  const longName = `  ${'R'.repeat(300)}  `
  const namedArtifact = {
    ...artifact,
    rows: artifact.rows.map((row) => {
      return {...row, provenance: {...row.provenance, reviewerDisplayName: longName}}
    }),
  }
  const oversizedArtifact = {
    ...artifact,
    judgmentContexts: [{context: {padding: 'x'.repeat(70 * 1024)}, id: missingContextId}],
  }

  await getDatabase().run(
    `DELETE FROM app.comparison_project_conflict_resolution WHERE comparison_project_id = '${comparisonProjectId}'`,
  )
  const importResponse = await postJson(
    `/api/comparison-projects/${comparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact: namedArtifact, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )
  const oversizedResponse = await postJson(
    `/api/comparison-projects/${comparisonProjectId}/conflict-resolutions/import/analyze`,
    {artifact: oversizedArtifact},
  )
  const storedNames = await getDatabase().queryJson<{nameLength: number}>(`
    SELECT DISTINCT CAST(LENGTH(reviewer_display_name) AS INTEGER) AS nameLength
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
  `)

  expect(importResponse.status).toBe(200)
  expect(storedNames).toEqual([{nameLength: 200}])
  expect(oversizedResponse.status).toBe(400)
  expect(await oversizedResponse.text()).toContain('exceeds 65536 bytes')
})

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {getAppDatabaseService} from './appDatabaseService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-judgment-context-generation')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const comparisonProjectId = 'comparison-context-summary'
const emptyCriteriaComparisonProjectId = 'comparison-context-empty-criteria'
const archivedComparisonProjectId = 'comparison-context-archived'

type Runner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

let database: ReturnType<typeof getAppDatabaseService> | null = null
let contextModule: typeof import('./comparisonJudgmentContext.ts') | null = null
let derivationModule: typeof import('./comparisonJudgmentContextDerivation.ts') | null = null
let backfillModule: typeof import('./comparisonJudgmentContextBackfill.ts') | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getModules = () => {
  if (contextModule === null || derivationModule === null || backfillModule === null) {
    throw new Error('Modules not initialized')
  }

  return {backfill: backfillModule, context: contextModule, derivation: derivationModule}
}

const getDatabaseRunner = () => {
  return {
    queryJson: <T>(statement: string) => {
      return getDatabase().queryJson<T>(statement)
    },
    run: (statement: string) => {
      return getDatabase().run(statement)
    },
    transaction: <T>(operation: (runner: Runner) => Promise<T>) => {
      return getDatabase().transaction(operation)
    },
  }
}

const getContextServingRows = () => {
  return getDatabase().queryJson<{comparisonProjectId: string; generation: string; judgmentContextId: string}>(`
    SELECT
      comparison_project_id AS comparisonProjectId,
      CAST(generation AS VARCHAR) AS generation,
      judgment_context_id AS judgmentContextId
    FROM mart.comparison_judgment_context_serving
    ORDER BY comparison_project_id ASC, generation ASC
  `)
}

const llmSettings = {
  contentKey: '1100',
  modelId: 'model-a',
  modelName: 'gpt-5.5',
  systemPromptVariant: 'legacy',
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useMetadata: false,
  useTitle: true,
}

const seedComparisonProjects = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('context-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('model-a', 'context-connection', 'gpt-5.5', 'model-a', 'GPT 5.5', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('source-project-a', 'Source Project A', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE),
      ('source-project-empty', 'Source Project Empty', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('prompt-a', 'Population text', 'Population', NULL, 'prompt-a-hash'),
      ('prompt-b', 'Exclusion text', 'Exclusion', NULL, 'prompt-b-hash'),
      ('prompt-c', 'Disabled text', 'Disabled', NULL, 'prompt-c-hash'),
      ('prompt-d', 'No section text', 'No section', NULL, 'prompt-d-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('source-a-prompt-a', 'source-project-a', 'prompt-a', 0, TRUE, 'include', 'population', 'Population'),
      ('source-a-prompt-b', 'source-project-a', 'prompt-b', 1, TRUE, 'exclude', 'exclusion', 'Exclusion'),
      ('source-a-prompt-c', 'source-project-a', 'prompt-c', 2, FALSE, 'include', 'disabled', 'Disabled'),
      ('source-a-prompt-d', 'source-project-a', 'prompt-d', 3, TRUE, 'include', NULL, NULL),
      ('source-empty-prompt-c', 'source-project-empty', 'prompt-c', 0, FALSE, 'include', 'disabled', 'Disabled');

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, human_judgment_mode, summary_source_project_id,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived
    )
    VALUES
      ('${comparisonProjectId}', 'Summary context', NULL, ['model-a'], TRUE, 'summary', 'source-project-a', TRUE, TRUE, FALSE, FALSE, FALSE),
      ('${emptyCriteriaComparisonProjectId}', 'Empty criteria', NULL, ['model-a'], TRUE, 'summary', 'source-project-empty', TRUE, TRUE, FALSE, FALSE, FALSE),
      ('${archivedComparisonProjectId}', 'Archived context', NULL, ['model-a'], TRUE, 'summary', 'source-project-a', TRUE, TRUE, FALSE, FALSE, TRUE);

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('comparison-source-a', '${comparisonProjectId}', 'source-project-a'),
      ('comparison-source-empty', '${emptyCriteriaComparisonProjectId}', 'source-project-empty'),
      ('comparison-source-archived', '${archivedComparisonProjectId}', 'source-project-a');

    INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation, serving_status)
    VALUES
      ('${comparisonProjectId}', 1, 'ready'),
      ('${emptyCriteriaComparisonProjectId}', 1, 'ready'),
      ('${archivedComparisonProjectId}', 1, 'ready');
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, context, derivation, backfill] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('./appDatabaseService.ts'),
    import('./comparisonJudgmentContext.ts'),
    import('./comparisonJudgmentContextDerivation.ts'),
    import('./comparisonJudgmentContextBackfill.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  contextModule = context
  derivationModule = derivation
  backfillModule = backfill
  await seedComparisonProjects()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('summary contexts come from the generation config: one column per served column with its criteria', async () => {
  const context = await getModules().derivation.computeComparisonJudgmentContextFromGenerationConfig(
    getDatabaseRunner(),
    {comparisonProjectId, generation: 1},
  )

  expect(context).toEqual({
    columns: [
      {kind: 'human', promptHeading: null, promptId: 'summary'},
      {
        ...llmSettings,
        criteria: [
          {criteriaDisposition: 'include', promptHeading: 'Population', promptId: 'prompt-a'},
          {criteriaDisposition: 'exclude', promptHeading: 'Exclusion', promptId: 'prompt-b'},
        ],
        kind: 'llm',
        promptHeading: null,
        promptId: 'summary',
        sourceProjectId: 'source-project-a',
      },
    ],
    humanJudgmentMode: 'summary',
    sourceProjectIds: ['source-project-a'],
    summarySourceProjectId: 'source-project-a',
    v: 1,
  })
  expect(
    await getDatabase().queryJson<{rowCount: number}>(`
      SELECT CAST(COUNT(*) AS INTEGER) AS rowCount
      FROM mart.comparison_system_prompt_variant_serving
      WHERE comparison_project_id = '${comparisonProjectId}'
    `),
  ).toEqual([{rowCount: 0}])
})

test('a summary column with no qualifying criteria is recorded with an empty criteria list', async () => {
  const context = await getModules().derivation.computeComparisonJudgmentContextFromGenerationConfig(
    getDatabaseRunner(),
    {comparisonProjectId: emptyCriteriaComparisonProjectId, generation: 1},
  )

  expect(context?.columns).toEqual([
    {kind: 'human', promptHeading: null, promptId: 'summary'},
    {...llmSettings, criteria: [], kind: 'llm', promptHeading: null, promptId: 'summary', sourceProjectId: null},
  ])
})

test('recording a generation context is idempotent and resolvable by id', async () => {
  const runner = getDatabaseRunner()
  const firstId = await getModules().derivation.recordComparisonJudgmentContextForGenerationConfig(runner, {
    comparisonProjectId,
    generation: 1,
  })
  const secondId = await getModules().derivation.recordComparisonJudgmentContextForGenerationConfig(runner, {
    comparisonProjectId,
    generation: 1,
  })
  const [summary] = await getModules().context.getComparisonJudgmentContextsByIds(runner, [firstId ?? ''])

  expect(firstId).toMatch(/^[0-9a-f]{64}$/)
  expect(secondId).toBe(firstId)
  expect(await getContextServingRows()).toEqual([
    {comparisonProjectId, generation: '1', judgmentContextId: firstId ?? ''},
  ])
  expect(
    await getModules().context.getComparisonJudgmentContextIdForGeneration(runner, {
      comparisonProjectId,
      generation: 1,
    }),
  ).toBe(firstId)
  expect(summary).toMatchObject({
    id: firstId,
    modelIds: ['model-a'],
    models: [{id: 'model-a', name: 'gpt-5.5'}],
    promptIds: ['prompt-a', 'prompt-b'],
    prompts: [
      {heading: null, id: 'summary'},
      {heading: 'Population', id: 'prompt-a'},
      {heading: 'Exclusion', id: 'prompt-b'},
    ],
    systemPromptVariants: ['legacy'],
  })
})

test('a failing context write is logged and swallowed so the build can continue', async () => {
  const failingRunner = {
    ...getDatabaseRunner(),
    run: async (statement: string) => {
      if (statement.includes('INSERT INTO app.comparison_judgment_context')) {
        throw new Error('simulated context write failure')
      }

      return getDatabase().run(statement)
    },
  }
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }

  try {
    expect(
      await getModules().derivation.recordComparisonJudgmentContextForGenerationConfig(failingRunner, {
        comparisonProjectId: emptyCriteriaComparisonProjectId,
        generation: 1,
      }),
    ).toBeNull()
  } finally {
    console.warn = originalWarn
  }

  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.[1]).toMatchObject({
    comparisonProjectId: emptyCriteriaComparisonProjectId,
    errorMessage: 'simulated context write failure',
    generation: 1,
  })
})

test('the backfill backs off a failing generation, keeps serving the others and skips archived projects', async () => {
  const {backfill, derivation} = getModules()
  const state = backfill.createComparisonJudgmentContextBackfillState()
  const start = new Date('2026-10-10T12:00:00.000Z')
  const computeContext: typeof derivation.computeComparisonJudgmentContextFromGenerationConfig = async (
    runner,
    params,
  ) => {
    if (params.comparisonProjectId === emptyCriteriaComparisonProjectId) {
      throw new Error('simulated backfill failure')
    }

    return derivation.computeComparisonJudgmentContextFromGenerationConfig(runner, params)
  }
  const runBackfill = (now: Date) => {
    return backfill.backfillNextComparisonJudgmentContext(getDatabaseRunner(), {computeContext, now, state})
  }

  await getDatabase().run('DELETE FROM mart.comparison_judgment_context_serving')

  const first = await runBackfill(start)
  const second = await runBackfill(start)
  const third = await runBackfill(start)
  const retry = await runBackfill(new Date(start.getTime() + backfill.comparisonJudgmentContextBackfillBaseDelayMs))
  const tooEarly = await runBackfill(
    new Date(start.getTime() + backfill.comparisonJudgmentContextBackfillBaseDelayMs + 1),
  )

  expect(first).toMatchObject({
    attempts: 1,
    comparisonProjectId: emptyCriteriaComparisonProjectId,
    errorMessage: 'simulated backfill failure',
    generation: 1,
    nextAttemptAt: new Date(start.getTime() + backfill.comparisonJudgmentContextBackfillBaseDelayMs),
    status: 'failed',
  })
  expect(second).toMatchObject({comparisonProjectId, generation: 1, status: 'written'})
  expect(third).toEqual({comparisonProjectId: null, generation: null, status: 'idle'})
  expect(retry).toMatchObject({attempts: 2, comparisonProjectId: emptyCriteriaComparisonProjectId, status: 'failed'})
  expect(tooEarly).toEqual({comparisonProjectId: null, generation: null, status: 'idle'})
  expect(await getContextServingRows()).toEqual([
    {
      comparisonProjectId,
      generation: '1',
      judgmentContextId: second.status === 'written' ? second.judgmentContextId : '',
    },
  ])
})

test('the backfill gives up on a generation after the attempt cap', async () => {
  const {backfill} = getModules()
  const state = backfill.createComparisonJudgmentContextBackfillState()
  const failingCompute = async () => {
    throw new Error('always failing')
  }
  const results = await Array.from({length: backfill.comparisonJudgmentContextBackfillMaxAttempts + 1}).reduce<
    Promise<Array<{status: string}>>
  >(async (promise, _value, index) => {
    const previous = await promise
    const result = await backfill.backfillNextComparisonJudgmentContext(getDatabaseRunner(), {
      computeContext: failingCompute,
      now: new Date(Date.UTC(2026, 9, 11) + index * 3_600_000),
      state,
    })

    return [...previous, result]
  }, Promise.resolve([]))

  expect(
    results.map((result) => {
      return result.status
    }),
  ).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'idle'])
  expect(results[backfill.comparisonJudgmentContextBackfillMaxAttempts - 1]).toMatchObject({
    attempts: backfill.comparisonJudgmentContextBackfillMaxAttempts,
    nextAttemptAt: null,
  })
})

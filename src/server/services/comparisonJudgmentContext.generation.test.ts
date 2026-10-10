import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {getAppDatabaseService} from './appDatabaseService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-judgment-context-generation')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const comparisonProjectId = 'comparison-context-summary'
const archivedComparisonProjectId = 'comparison-context-archived'

let database: ReturnType<typeof getAppDatabaseService> | null = null
let contextModule: typeof import('./comparisonJudgmentContext.ts') | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getContextModule = () => {
  if (contextModule === null) {
    throw new Error('Context module not initialized')
  }

  return contextModule
}

const getDatabaseRunner = () => {
  return {
    queryJson: <T>(statement: string) => {
      return getDatabase().queryJson<T>(statement)
    },
    run: (statement: string) => {
      return getDatabase().run(statement)
    },
    transaction: <T>(
      operation: (runner: {
        queryJson: <R>(statement: string) => Promise<R[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
    ) => {
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

const seedSummaryComparisonProject = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('context-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('model-a', 'context-connection', 'gpt-5.5', 'model-a', 'GPT 5.5', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('source-project-a', 'Source Project A', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE);

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
      ('source-a-prompt-d', 'source-project-a', 'prompt-d', 3, TRUE, 'include', NULL, NULL);

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, human_judgment_mode, summary_source_project_id,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived
    )
    VALUES
      ('${comparisonProjectId}', 'Summary context', NULL, ['model-a'], TRUE, 'summary', 'source-project-a', TRUE, TRUE, FALSE, FALSE, FALSE),
      ('${archivedComparisonProjectId}', 'Archived context', NULL, ['model-a'], TRUE, 'summary', 'source-project-a', TRUE, TRUE, FALSE, FALSE, TRUE);

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition)
    VALUES ('comparison-prompt-a', '${comparisonProjectId}', 'prompt-a', 0, 'include');

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES ('comparison-source-a', '${comparisonProjectId}', 'source-project-a');

    INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation, serving_status)
    VALUES ('${comparisonProjectId}', 1, 'ready'), ('${archivedComparisonProjectId}', 1, 'ready');

    INSERT INTO mart.comparison_cell_serving (
      comparison_project_id, generation, article_id, column_id, column_order, kind, prompt_id, model_id,
      source_project_id, content_key, display_answer, normalized_answers
    )
    VALUES
      ('${comparisonProjectId}', 1, 'article-1', 'llm:source-project-a:model-a:1100:summary', 0, 'llm', 'summary', 'model-a', 'source-project-a', '1100', 'yes', ['yes']),
      ('${comparisonProjectId}', 1, 'article-2', 'llm:source-project-a:model-a:1100:summary', 0, 'llm', 'summary', 'model-a', 'source-project-a', '1100', 'no', ['no']),
      ('${comparisonProjectId}', 1, 'article-1', 'llm:model-a:1100-screening_v1:summary', 1, 'llm', 'summary', 'model-a', NULL, '1100-screening_v1', 'yes', ['yes']),
      ('${comparisonProjectId}', 1, 'article-1', 'human:summary', 2, 'human', 'summary', NULL, NULL, NULL, 'no', ['no']),
      ('${archivedComparisonProjectId}', 1, 'article-1', 'human:summary', 0, 'human', 'summary', NULL, NULL, NULL, 'no', ['no']);
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, module] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('./appDatabaseService.ts'),
    import('./comparisonJudgmentContext.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  contextModule = module
  await seedSummaryComparisonProject()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('summary generations expand each served LLM summary column into the prompts that produced it', async () => {
  const context = await getContextModule().computeComparisonJudgmentContextForGeneration(getDatabaseRunner(), {
    comparisonProjectId,
    generation: 1,
  })
  const llmSettings = {
    modelId: 'model-a',
    modelName: 'gpt-5.5',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
  }

  expect(context).toEqual({
    columns: [
      {kind: 'human', promptHeading: null, promptId: 'summary'},
      {
        ...llmSettings,
        criteriaDisposition: 'include',
        kind: 'llm',
        promptHeading: 'Population',
        promptId: 'prompt-a',
        sourceProjectId: 'source-project-a',
        systemPromptVariant: 'legacy',
      },
      {
        ...llmSettings,
        criteriaDisposition: 'include',
        kind: 'llm',
        promptHeading: 'Population',
        promptId: 'prompt-a',
        sourceProjectId: null,
        systemPromptVariant: 'screening_v1',
      },
      {
        ...llmSettings,
        criteriaDisposition: 'exclude',
        kind: 'llm',
        promptHeading: 'Exclusion',
        promptId: 'prompt-b',
        sourceProjectId: 'source-project-a',
        systemPromptVariant: 'legacy',
      },
    ],
    humanJudgmentMode: 'summary',
    sourceProjectIds: ['source-project-a'],
    summarySourceProjectId: 'source-project-a',
    v: 1,
  })
})

test('writing a generation context is idempotent and resolvable by id', async () => {
  const runner = getDatabaseRunner()
  const firstId = await getContextModule().writeComparisonJudgmentContextForGeneration(runner, {
    comparisonProjectId,
    generation: 1,
  })
  const secondId = await getContextModule().writeComparisonJudgmentContextForGeneration(runner, {
    comparisonProjectId,
    generation: 1,
  })
  const [summary] = await getContextModule().getComparisonJudgmentContextsByIds(runner, [
    firstId ?? '',
    'not-a-context-id',
  ])

  expect(firstId).toMatch(/^[0-9a-f]{64}$/)
  expect(secondId).toBe(firstId)
  expect(await getContextServingRows()).toEqual([
    {comparisonProjectId, generation: '1', judgmentContextId: firstId ?? ''},
  ])
  expect(
    await getContextModule().getComparisonJudgmentContextIdForGeneration(runner, {comparisonProjectId, generation: 1}),
  ).toBe(firstId)
  expect(
    await getDatabase().queryJson<{contextCount: number}>(
      'SELECT CAST(COUNT(*) AS INTEGER) AS contextCount FROM app.comparison_judgment_context',
    ),
  ).toEqual([{contextCount: 1}])
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
    systemPromptVariants: ['legacy', 'screening_v1'],
  })
})

test('the maintenance backfill writes one missing active generation context per call and skips archived projects', async () => {
  await getDatabase().run('DELETE FROM mart.comparison_judgment_context_serving')

  const firstResult = await getContextModule().backfillNextComparisonJudgmentContext(getDatabaseRunner())
  const secondResult = await getContextModule().backfillNextComparisonJudgmentContext(getDatabaseRunner())

  expect(firstResult).toMatchObject({comparisonProjectId, generation: 1})
  expect(firstResult.judgmentContextId).toMatch(/^[0-9a-f]{64}$/)
  expect(secondResult).toEqual({comparisonProjectId: null, generation: null, judgmentContextId: null})
  expect(await getContextServingRows()).toEqual([
    {comparisonProjectId, generation: '1', judgmentContextId: firstResult.judgmentContextId ?? ''},
  ])
})

test('changing a criteria disposition or a prompt changes the context id of the next generation', async () => {
  const runner = getDatabaseRunner()
  const [originalId] = await getContextServingRows().then((rows) => {
    return rows.map((row) => {
      return row.judgmentContextId
    })
  })

  await getDatabase().run(`
    UPDATE app.project_prompt SET criteria_disposition = 'include' WHERE id = 'source-a-prompt-b';
    INSERT INTO mart.comparison_cell_serving (
      comparison_project_id, generation, article_id, column_id, column_order, kind, prompt_id, model_id,
      source_project_id, content_key, display_answer, normalized_answers
    )
    SELECT comparison_project_id, 2, article_id, column_id, column_order, kind, prompt_id, model_id,
      source_project_id, content_key, display_answer, normalized_answers
    FROM mart.comparison_cell_serving
    WHERE comparison_project_id = '${comparisonProjectId}' AND generation = 1;
  `)

  const changedId = await getContextModule().writeComparisonJudgmentContextForGeneration(runner, {
    comparisonProjectId,
    generation: 2,
  })

  expect(changedId).toMatch(/^[0-9a-f]{64}$/)
  expect(changedId).not.toBe(originalId)
})

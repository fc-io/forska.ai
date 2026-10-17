import {rmSync} from 'node:fs'

import {expect, setDefaultTimeout, test} from 'bun:test'

import {
  getComparisonProjectColumnId,
  getComparisonProjectContentKey,
} from '../routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts'

setDefaultTimeout(120_000)

type FullTextStrategyServingCellsResult = {
  actualRows: Array<{articleId: string; columnId: string; comparisonProjectId: string; displayAnswer: string | null}>
  contentOrders: Record<string, string[]>
  contextColumns: Array<{contentKey: string; fullTextStrategyId?: string; fullTextStrategyLabel?: string}>
  requiredColumnIds: Record<string, string[]>
  servedContentDimensions: Record<string, string[]>
}

const strategyA = 'fts-aaaaaaaaaaaaaaaa'
const strategyB = 'fts-bbbbbbbbbbbbbbbb'
const titleAbstractSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
const fullTextSettings = {useAbstract: false, useFulltext: true, useFulltextNoImages: false, useTitle: false}
const summaryPromptId = 'summary'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true})
}

const getLastJsonLine = (stdout: string) => {
  const jsonLine = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((line) => {
      return line.trim().startsWith('{')
    })

  return jsonLine ?? '{}'
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/fts-comparison-serving-cells-${Date.now()}-${Math.random().toString(16).slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', body], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'Comparison full-text strategy test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
}

const getFullTextStrategyServingCellsScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getComparisonProjectServingCellBuilder} = await import('./src/server/services/comparisonProjectServingCellBuilder.ts')
    const {computeComparisonJudgmentContextFromGenerationConfig} = await import('./src/server/services/comparisonJudgmentContextDerivation.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingCellBuilder()
    const runner = {queryJson: database.queryJson, run: database.run}

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-fts-cells', 'sglang', 'Provider FTS Cells', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, variant, source, enabled, metadata_json)
      VALUES ('model-a', 'provider-fts-cells', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.full_text_strategy (id, label, inputs)
      VALUES
        ('${strategyA}', 'mineru 4.0 / none / single 96k', '{}'::JSON),
        ('${strategyB}', 'mineru 4.0 / descriptions / single 96k', '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        description,
        model_id,
        human_judgment_mode,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        full_text_strategy_id
      ) VALUES
        ('source-ta', 'Source TA', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE, NULL),
        ('source-ft-a', 'Source FT A', NULL, 'model-a', 'summary', FALSE, FALSE, TRUE, FALSE, '${strategyA}'),
        ('source-ft-b', 'Source FT B', NULL, 'model-a', 'summary', FALSE, FALSE, TRUE, FALSE, '${strategyB}')
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES
        ('prompt-f', 'Prompt F', 'Prompt F', NULL, 'prompt-f-hash', TIMESTAMPTZ '2026-06-01T00:00:00.000Z'),
        ('prompt-n', 'Prompt N', 'Prompt N', NULL, 'prompt-n-hash', TIMESTAMPTZ '2026-06-01T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.project_prompt (
        id,
        project_id,
        prompt_id,
        prompt_order,
        enabled,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label
      ) VALUES
        ('source-ft-a-prompt-f', 'source-ft-a', 'prompt-f', 0, TRUE, 'include', 'population', 'Population'),
        ('source-ft-b-prompt-f', 'source-ft-b', 'prompt-f', 0, TRUE, 'include', 'population', 'Population')
    \`)

    await database.run(\`
      INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at, article_updated_at)
      VALUES ('article-f', 'external-f', 'Article F', 'Summary F', TIMESTAMPTZ '2026-06-01T00:00:00.000Z', TIMESTAMPTZ '2026-06-01T01:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('source-ta-article-f', 'source-ta', 'article-f'),
        ('source-ft-a-article-f', 'source-ft-a', 'article-f'),
        ('source-ft-b-article-f', 'source-ft-b', 'article-f')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project (
        id,
        name,
        description,
        model_ids,
        compare_with_humans,
        human_judgment_mode,
        summary_source_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('comparison-fts-ab', 'FTS AB', NULL, ['model-a'], FALSE, 'prompt', NULL, TRUE, TRUE, TRUE, FALSE),
        ('comparison-fts-none', 'FTS None', NULL, ['model-a'], FALSE, 'prompt', NULL, TRUE, TRUE, TRUE, FALSE),
        ('comparison-fts-route', 'FTS Route', NULL, ['model-a'], FALSE, 'prompt', NULL, FALSE, FALSE, TRUE, FALSE),
        ('comparison-fts-summary', 'FTS Summary', NULL, ['model-a'], TRUE, 'summary', NULL, FALSE, FALSE, TRUE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition)
      VALUES
        ('comparison-fts-ab-prompt-f', 'comparison-fts-ab', 'prompt-f', 0, NULL),
        ('comparison-fts-none-prompt-n', 'comparison-fts-none', 'prompt-n', 0, NULL),
        ('comparison-fts-route-prompt-f', 'comparison-fts-route', 'prompt-f', 0, NULL),
        ('comparison-fts-summary-prompt-f', 'comparison-fts-summary', 'prompt-f', 0, 'include')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id, created_at)
      VALUES
        ('comparison-fts-ab-ta', 'comparison-fts-ab', 'source-ta', TIMESTAMPTZ '2026-06-01T00:00:00.000Z'),
        ('comparison-fts-ab-a', 'comparison-fts-ab', 'source-ft-a', TIMESTAMPTZ '2026-06-02T00:00:00.000Z'),
        ('comparison-fts-ab-b', 'comparison-fts-ab', 'source-ft-b', TIMESTAMPTZ '2026-06-03T00:00:00.000Z'),
        ('comparison-fts-none-ta', 'comparison-fts-none', 'source-ta', TIMESTAMPTZ '2026-06-01T00:00:00.000Z'),
        ('comparison-fts-summary-a', 'comparison-fts-summary', 'source-ft-a', TIMESTAMPTZ '2026-06-01T00:00:00.000Z'),
        ('comparison-fts-summary-b', 'comparison-fts-summary', 'source-ft-b', TIMESTAMPTZ '2026-06-02T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        is_answered,
        answered_original,
        answered_original_as_array,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        use_metadata,
        system_prompt_variant,
        full_text_strategy_id,
        created_at,
        updated_at
      ) VALUES
        ('judgment-f-ta', 'article-f', 'prompt-f', 'model-a', 'source-ta', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, FALSE, 'legacy', 'fts-none', TIMESTAMPTZ '2026-06-03T00:00:00.000Z', TIMESTAMPTZ '2026-06-03T01:00:00.000Z'),
        ('judgment-f-a', 'article-f', 'prompt-f', 'model-a', 'source-ft-a', TRUE, 'no', NULL, FALSE, FALSE, TRUE, FALSE, FALSE, 'legacy', '${strategyA}', TIMESTAMPTZ '2026-06-04T00:00:00.000Z', TIMESTAMPTZ '2026-06-04T01:00:00.000Z'),
        ('judgment-f-b', 'article-f', 'prompt-f', 'model-a', 'source-ft-b', TRUE, 'maybe', NULL, FALSE, FALSE, TRUE, FALSE, FALSE, 'legacy', '${strategyB}', TIMESTAMPTZ '2026-06-05T00:00:00.000Z', TIMESTAMPTZ '2026-06-05T01:00:00.000Z'),
        ('judgment-n-ta', 'article-f', 'prompt-n', 'model-a', 'source-ta', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, FALSE, 'legacy', 'fts-none', TIMESTAMPTZ '2026-06-03T00:00:00.000Z', TIMESTAMPTZ '2026-06-03T01:00:00.000Z')
    \`)

    await builder.insertPromptModeComparisonProjectCells({comparisonProjectId: 'comparison-fts-ab', generation: 1}, runner)
    await builder.insertPromptModeComparisonProjectCells({comparisonProjectId: 'comparison-fts-none', generation: 1}, runner)
    await builder.insertPromptModeComparisonProjectCells({comparisonProjectId: 'comparison-fts-route', generation: 1}, runner)
    await builder.insertSummaryModeComparisonProjectLlmCells({comparisonProjectId: 'comparison-fts-summary', generation: 1}, runner)

    const actualRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        article_id AS articleId,
        column_id AS columnId,
        display_answer AS displayAnswer
      FROM mart.comparison_cell_serving
      WHERE generation = 1
      ORDER BY comparison_project_id ASC, column_id ASC
    \`)
    const requiredColumnRows = await database.queryJson(\`
      SELECT comparison_project_id AS comparisonProjectId, column_id AS columnId
      FROM comparison_serving_generation_required_column_config
      WHERE generation = 1
      ORDER BY comparison_project_id ASC, column_id ASC
    \`)
    const requiredColumnIds = requiredColumnRows.reduce((columnMap, row) => {
      return {...columnMap, [row.comparisonProjectId]: [...(columnMap[row.comparisonProjectId] ?? []), row.columnId]}
    }, {})
    const servedDimensionRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        system_prompt_variant || ':' || CAST(use_metadata AS VARCHAR) || ':' || full_text_strategy_id AS contentDimension
      FROM mart.comparison_system_prompt_variant_serving
      WHERE generation = 1
      ORDER BY comparison_project_id ASC, contentDimension ASC
    \`)
    const servedContentDimensions = servedDimensionRows.reduce((dimensionMap, row) => {
      return {
        ...dimensionMap,
        [row.comparisonProjectId]: [...(dimensionMap[row.comparisonProjectId] ?? []), row.contentDimension],
      }
    }, {})
    const contentOrderRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        content_key || ':' || CAST(content_order AS VARCHAR) AS contentOrder
      FROM comparison_serving_generation_content_variant_config
      WHERE generation = 1
      ORDER BY comparison_project_id ASC, content_order ASC
    \`)
    const contentOrders = contentOrderRows.reduce((orderMap, row) => {
      return {...orderMap, [row.comparisonProjectId]: [...(orderMap[row.comparisonProjectId] ?? []), row.contentOrder]}
    }, {})
    const context = await computeComparisonJudgmentContextFromGenerationConfig(runner, {
      comparisonProjectId: 'comparison-fts-ab',
      generation: 1,
    })
    const contextColumns = (context?.columns ?? []).map((column) => {
      return {
        contentKey: column.contentKey,
        fullTextStrategyId: column.fullTextStrategyId,
        fullTextStrategyLabel: column.fullTextStrategyLabel,
      }
    })

    console.log(JSON.stringify({actualRows, contentOrders, contextColumns, requiredColumnIds, servedContentDimensions}))
  `
}

test('full-text strategies discovered in scope become separate comparison columns keyed like the TypeScript content key', () => {
  const result = runScript<FullTextStrategyServingCellsResult>(getFullTextStrategyServingCellsScript())
  const titleAbstractContentKey = getComparisonProjectContentKey(titleAbstractSettings)
  const fullTextNoneContentKey = getComparisonProjectContentKey(fullTextSettings)
  const fullTextAContentKey = getComparisonProjectContentKey({...fullTextSettings, fullTextStrategyId: strategyA})
  const fullTextBContentKey = getComparisonProjectContentKey({...fullTextSettings, fullTextStrategyId: strategyB})
  const titleAbstractColumnId = getComparisonProjectColumnId('llm', 'prompt-f', 'model-a', titleAbstractContentKey)
  const fullTextAColumnId = getComparisonProjectColumnId('llm', 'prompt-f', 'model-a', fullTextAContentKey)
  const fullTextBColumnId = getComparisonProjectColumnId('llm', 'prompt-f', 'model-a', fullTextBContentKey)
  const noneTitleAbstractColumnId = getComparisonProjectColumnId('llm', 'prompt-n', 'model-a', titleAbstractContentKey)
  const noneFullTextColumnId = getComparisonProjectColumnId('llm', 'prompt-n', 'model-a', fullTextNoneContentKey)
  const summaryAColumnId = getComparisonProjectColumnId(
    'llm',
    summaryPromptId,
    'model-a',
    fullTextAContentKey,
    'source-ft-a',
  )
  const summaryBColumnId = getComparisonProjectColumnId(
    'llm',
    summaryPromptId,
    'model-a',
    fullTextBContentKey,
    'source-ft-b',
  )

  expect(fullTextNoneContentKey).toBe('0010')
  expect(fullTextAContentKey).toBe(`0010~${strategyA}`)
  expect(getComparisonProjectContentKey({...fullTextSettings, fullTextStrategyId: 'fts-none'})).toBe('0010')
  expect(
    getComparisonProjectContentKey({
      ...fullTextSettings,
      fullTextStrategyId: strategyB,
      systemPromptVariant: 'screening_v1',
      useMetadata: true,
    }),
  ).toBe(`0010m-screening_v1~${strategyB}`)
  expect(result.servedContentDimensions).toEqual({
    'comparison-fts-ab': [
      'legacy:false:fts-aaaaaaaaaaaaaaaa',
      'legacy:false:fts-bbbbbbbbbbbbbbbb',
      'legacy:false:fts-none',
    ],
    'comparison-fts-none': ['legacy:false:fts-none'],
    'comparison-fts-route': ['legacy:false:fts-aaaaaaaaaaaaaaaa', 'legacy:false:fts-bbbbbbbbbbbbbbbb'],
    'comparison-fts-summary': ['legacy:false:fts-aaaaaaaaaaaaaaaa', 'legacy:false:fts-bbbbbbbbbbbbbbbb'],
  })
  expect(result.contentOrders).toEqual({
    'comparison-fts-ab': ['1100:0', `${fullTextAContentKey}:19`, `${fullTextBContentKey}:37`],
    'comparison-fts-none': ['1100:0', '0010:1'],
    'comparison-fts-route': [`${fullTextAContentKey}:1`, `${fullTextBContentKey}:19`],
    'comparison-fts-summary': [`${fullTextAContentKey}:1`, `${fullTextBContentKey}:19`],
  })
  expect(result.actualRows).toEqual([
    {
      articleId: 'article-f',
      columnId: fullTextAColumnId,
      comparisonProjectId: 'comparison-fts-ab',
      displayAnswer: 'no',
    },
    {
      articleId: 'article-f',
      columnId: fullTextBColumnId,
      comparisonProjectId: 'comparison-fts-ab',
      displayAnswer: 'maybe',
    },
    {
      articleId: 'article-f',
      columnId: titleAbstractColumnId,
      comparisonProjectId: 'comparison-fts-ab',
      displayAnswer: 'yes',
    },
    {
      articleId: 'article-f',
      columnId: noneTitleAbstractColumnId,
      comparisonProjectId: 'comparison-fts-none',
      displayAnswer: 'yes',
    },
    {
      articleId: 'article-f',
      columnId: fullTextAColumnId,
      comparisonProjectId: 'comparison-fts-route',
      displayAnswer: 'no',
    },
    {
      articleId: 'article-f',
      columnId: fullTextBColumnId,
      comparisonProjectId: 'comparison-fts-route',
      displayAnswer: 'maybe',
    },
    {
      articleId: 'article-f',
      columnId: summaryAColumnId,
      comparisonProjectId: 'comparison-fts-summary',
      displayAnswer: 'no',
    },
    {
      articleId: 'article-f',
      columnId: summaryBColumnId,
      comparisonProjectId: 'comparison-fts-summary',
      displayAnswer: 'maybe',
    },
  ])
  expect(result.requiredColumnIds).toEqual({
    'comparison-fts-ab': [fullTextAColumnId, fullTextBColumnId, titleAbstractColumnId],
    'comparison-fts-none': [noneFullTextColumnId, noneTitleAbstractColumnId],
    'comparison-fts-route': [fullTextAColumnId, fullTextBColumnId],
    'comparison-fts-summary': ['human:summary', summaryAColumnId, summaryBColumnId],
  })
  expect(
    [...result.contextColumns].sort((left, right) => {
      return left.contentKey.localeCompare(right.contentKey)
    }),
  ).toEqual([
    {
      contentKey: fullTextAContentKey,
      fullTextStrategyId: strategyA,
      fullTextStrategyLabel: 'mineru 4.0 / none / single 96k',
    },
    {
      contentKey: fullTextBContentKey,
      fullTextStrategyId: strategyB,
      fullTextStrategyLabel: 'mineru 4.0 / descriptions / single 96k',
    },
    {contentKey: titleAbstractContentKey},
  ])
})

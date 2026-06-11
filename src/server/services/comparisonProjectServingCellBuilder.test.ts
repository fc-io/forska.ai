import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  type ComparisonProjectJudgmentHumanRow,
  type ComparisonProjectJudgmentLlmRow,
  getComparisonProjectBatchCellsByArticle,
  getComparisonProjectColumnId,
  getComparisonProjectContentKey,
} from '../routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts'
import {
  getComparisonProjectServingCellBuilder,
  getPromptModeComparisonProjectHumanCellServingInsertSql,
  getPromptModeComparisonProjectLlmCellServingInsertSql,
  getSummaryModeComparisonProjectHumanCellServingInsertSql,
  getSummaryModeComparisonProjectLlmCellServingInsertSql,
} from './comparisonProjectServingCellBuilder.ts'

type ActualServingCellRow = {
  articleId: string
  columnId: string
  columnOrder: number
  contentKey: string | null
  displayAnswer: string | null
  kind: string
  modelId: string | null
  normalizedAnswers: string[]
  promptId: string
  sourceProjectId: string | null
}

type PromptModeServingCellsResult = {actualRows: ActualServingCellRow[]}
type SummaryModeServingCellsResult = {actualRows: Array<ActualServingCellRow & {comparisonProjectId: string}>}
type MaterializedModelOrderResult = {
  actualRows: Array<{columnOrder: number; comparisonProjectId: string; modelId: string}>
}

const comparisonProjectId = 'comparison-project-prompt-cells'
const summaryModeComparisonProjectId = 'comparison-project-summary-cells'
const missingMetadataComparisonProjectId = 'comparison-project-summary-missing-metadata'
const contentSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
const contentKey = getComparisonProjectContentKey(contentSettings)
const summaryPromptId = 'summary'

const getArticleBatchRows = (start: number, end: number) => {
  return Array.from({length: end - start}, (_, index) => {
    return {articleId: `article-${String(start + index).padStart(4, '0')}`}
  })
}

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getExpectedLlmRows = (): ComparisonProjectJudgmentLlmRow[] => {
  return [
    {
      ...contentSettings,
      answeredOriginal: ' Yes ',
      answeredOriginalAsArray: null,
      articleId: 'article-with-cells',
      createdAt: new Date('2026-04-04T00:00:00.000Z'),
      modelId: 'model-a',
      promptId: 'prompt-a',
      sourceProjectId: null,
    },
    {
      ...contentSettings,
      answeredOriginal: null,
      answeredOriginalAsArray: [' beta ', 'alpha', ''],
      articleId: 'article-with-cells',
      createdAt: new Date('2026-04-04T00:00:00.000Z'),
      modelId: 'model-a',
      promptId: 'prompt-b',
      sourceProjectId: null,
    },
  ]
}

const getExpectedHumanRows = (): ComparisonProjectJudgmentHumanRow[] => {
  return [
    {
      answer: 'yes',
      articleId: 'article-with-cells',
      promptId: 'prompt-a',
      updatedAt: new Date('2026-04-05T00:00:00.000Z'),
    },
    {
      answer: ' No ',
      articleId: 'article-with-cells',
      promptId: 'prompt-a',
      updatedAt: new Date('2026-04-06T00:00:00.000Z'),
    },
    {
      answer: ' Maybe ',
      articleId: 'article-human-only',
      promptId: 'prompt-b',
      updatedAt: new Date('2026-04-07T00:00:00.000Z'),
    },
  ]
}

const getActualCellsByArticle = (actualRows: ActualServingCellRow[]) => {
  return actualRows.reduce<Record<string, Record<string, string | null>>>((articleMap, row) => {
    const articleCells = articleMap[row.articleId] ?? {}

    return {...articleMap, [row.articleId]: {...articleCells, [row.columnId]: row.displayAnswer}}
  }, {})
}

const getMergedCellsByArticle = (
  leftCellsByArticle: Record<string, Record<string, string | null>>,
  rightCellsByArticle: Record<string, Record<string, string | null>>,
) => {
  const articleIds = new Set([...Object.keys(leftCellsByArticle), ...Object.keys(rightCellsByArticle)])

  return Array.from(articleIds).reduce<Record<string, Record<string, string | null>>>((cellMap, articleId) => {
    return {
      ...cellMap,
      [articleId]: {...(leftCellsByArticle[articleId] ?? {}), ...(rightCellsByArticle[articleId] ?? {})},
    }
  }, {})
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-comparison-project-serving-cells-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
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
        runResult.stderr.toString() || runResult.stdout.toString() || 'Comparison serving cell builder test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
}

const getPromptModeServingCellsScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getComparisonProjectServingCellBuilder} = await import('./src/server/services/comparisonProjectServingCellBuilder.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingCellBuilder()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-cells', 'sglang', 'Provider Cells', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES
        ('model-a', 'provider-cells', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-cells', 'Model B', 'model-b', 'Model B', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        description,
        model_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('source-project', 'Source Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE),
        ('human-old-project', 'Human Old Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE),
        ('human-new-project', 'Human New Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE),
        ('human-blank-project', 'Human Blank Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE),
        ('human-only-project', 'Human Only Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE),
        ('human-out-project', 'Human Out Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES
        ('prompt-a', 'Prompt A', 'Prompt A', NULL, 'prompt-a-hash', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
        ('prompt-b', 'Prompt B', 'Prompt B', NULL, 'prompt-b-hash', TIMESTAMPTZ '2026-04-02T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_created_at,
        article_updated_at
      ) VALUES
        ('article-with-cells', 'external-with-cells', 'Article With Cells', 'Summary With Cells', TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T01:00:00.000Z'),
        ('article-human-only', 'external-human-only', 'Article Human Only', 'Summary Human Only', TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('article-missing', 'external-missing', 'Article Missing', 'Summary Missing', TIMESTAMPTZ '2026-04-05T00:00:00.000Z', TIMESTAMPTZ '2026-04-05T01:00:00.000Z'),
        ('article-out-of-scope', 'external-out-of-scope', 'Article Out', 'Summary Out', TIMESTAMPTZ '2026-04-06T00:00:00.000Z', TIMESTAMPTZ '2026-04-06T01:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('source-article-with-cells', 'source-project', 'article-with-cells'),
        ('source-article-human-only', 'source-project', 'article-human-only'),
        ('source-article-missing', 'source-project', 'article-missing')
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
      ) VALUES (
        '${comparisonProjectId}',
        'Comparison Prompt Cells',
        NULL,
        ['model-a', 'model-b'],
        TRUE,
        'prompt',
        NULL,
        TRUE,
        TRUE,
        FALSE,
        FALSE
      )
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
      VALUES
        ('comparison-prompt-a', '${comparisonProjectId}', 'prompt-a', 0),
        ('comparison-prompt-b', '${comparisonProjectId}', 'prompt-b', 1)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
      VALUES ('comparison-source-project', '${comparisonProjectId}', 'source-project')
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
        created_at,
        updated_at
      ) VALUES
        ('judgment-llm-yes', 'article-with-cells', 'prompt-a', 'model-a', 'source-project', TRUE, ' Yes ', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('judgment-llm-array', 'article-with-cells', 'prompt-b', 'model-a', 'source-project', TRUE, NULL, [' beta ', 'alpha', ''], TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('judgment-llm-missing', 'article-missing', 'prompt-a', 'model-b', 'source-project', FALSE, '   ', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('judgment-llm-out-of-scope', 'article-out-of-scope', 'prompt-a', 'model-a', 'source-project', TRUE, 'out', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.judgment_human (
        id,
        project_id,
        article_id,
        prompt_id,
        is_answered,
        answer,
        created_at,
        updated_at
      ) VALUES
        ('human-old', 'human-old-project', 'article-with-cells', 'prompt-a', TRUE, 'yes', TIMESTAMPTZ '2026-04-05T00:00:00.000Z', TIMESTAMPTZ '2026-04-05T00:00:00.000Z'),
        ('human-new', 'human-new-project', 'article-with-cells', 'prompt-a', TRUE, ' No ', TIMESTAMPTZ '2026-04-06T00:00:00.000Z', TIMESTAMPTZ '2026-04-06T00:00:00.000Z'),
        ('human-blank', 'human-blank-project', 'article-with-cells', 'prompt-a', TRUE, '   ', TIMESTAMPTZ '2026-04-07T00:00:00.000Z', TIMESTAMPTZ '2026-04-07T00:00:00.000Z'),
        ('human-only', 'human-only-project', 'article-human-only', 'prompt-b', TRUE, ' Maybe ', TIMESTAMPTZ '2026-04-07T00:00:00.000Z', TIMESTAMPTZ '2026-04-07T00:00:00.000Z'),
        ('human-missing', 'human-only-project', 'article-missing', 'prompt-b', FALSE, 'yes', TIMESTAMPTZ '2026-04-07T00:00:00.000Z', TIMESTAMPTZ '2026-04-07T00:00:00.000Z'),
        ('human-out-of-scope', 'human-out-project', 'article-out-of-scope', 'prompt-a', TRUE, 'out', TIMESTAMPTZ '2026-04-07T00:00:00.000Z', TIMESTAMPTZ '2026-04-07T00:00:00.000Z')
    \`)

    await builder.insertPromptModeComparisonProjectCells(
      {comparisonProjectId: '${comparisonProjectId}', generation: 1},
      {queryJson: database.queryJson, run: database.run},
    )

    const actualRows = await database.queryJson(\`
      SELECT
        article_id AS articleId,
        column_id AS columnId,
        CAST(column_order AS INTEGER) AS columnOrder,
        kind,
        prompt_id AS promptId,
        model_id AS modelId,
        source_project_id AS sourceProjectId,
        content_key AS contentKey,
        display_answer AS displayAnswer,
        TO_JSON(normalized_answers) AS normalizedAnswersJson
      FROM mart.comparison_cell_serving
      WHERE comparison_project_id = '${comparisonProjectId}'
        AND generation = 1
      ORDER BY article_id ASC, column_order ASC, column_id ASC
    \`)

    const getJsonValue = (value) => {
      return typeof value === 'string' ? JSON.parse(value) : value
    }
    const normalizedRows = actualRows.map((row) => {
      return {...row, normalizedAnswers: getJsonValue(row.normalizedAnswersJson)}
    })

    console.log(JSON.stringify({actualRows: normalizedRows}))
  `
}

test('prompt-mode serving cells match current TypeScript row assembly', () => {
  const result = runScript<PromptModeServingCellsResult>(getPromptModeServingCellsScript())
  const expectedCells = getComparisonProjectBatchCellsByArticle({
    humanRows: getExpectedHumanRows(),
    llmRows: getExpectedLlmRows(),
  })
  const expectedCellsByArticle = getMergedCellsByArticle(
    expectedCells.llmCellsByArticle,
    expectedCells.humanCellsByArticle,
  )
  const actualCells = getActualCellsByArticle(result.actualRows)
  const llmYesColumnId = getComparisonProjectColumnId('llm', 'prompt-a', 'model-a', contentKey)
  const llmArrayColumnId = getComparisonProjectColumnId('llm', 'prompt-b', 'model-a', contentKey)
  const llmMissingColumnId = getComparisonProjectColumnId('llm', 'prompt-a', 'model-b', contentKey)
  const humanPromptAColumnId = getComparisonProjectColumnId('human', 'prompt-a')
  const humanPromptBColumnId = getComparisonProjectColumnId('human', 'prompt-b')
  const rowsByArticleAndColumn = result.actualRows.reduce<Map<string, ActualServingCellRow>>((rowMap, row) => {
    rowMap.set(`${row.articleId}:${row.columnId}`, row)
    return rowMap
  }, new Map<string, ActualServingCellRow>())

  expect(actualCells).toEqual(expectedCellsByArticle)
  expect(actualCells).toEqual({
    'article-human-only': {[humanPromptBColumnId]: 'Maybe'},
    'article-with-cells': {[humanPromptAColumnId]: 'No', [llmArrayColumnId]: 'beta\nalpha', [llmYesColumnId]: 'Yes'},
  })
  expect(actualCells['article-missing']).toBeUndefined()
  expect(actualCells['article-out-of-scope']).toBeUndefined()
  expect(actualCells['article-with-cells']?.[llmMissingColumnId]).toBeUndefined()
  expect(rowsByArticleAndColumn.get(`article-with-cells:${llmYesColumnId}`)?.normalizedAnswers).toEqual(['yes'])
  expect(rowsByArticleAndColumn.get(`article-with-cells:${llmArrayColumnId}`)?.normalizedAnswers).toEqual([
    'beta',
    'alpha',
  ])
  expect(rowsByArticleAndColumn.get(`article-with-cells:${humanPromptAColumnId}`)?.normalizedAnswers).toEqual(['no'])
  expect(rowsByArticleAndColumn.get(`article-human-only:${humanPromptBColumnId}`)?.normalizedAnswers).toEqual(['maybe'])
  expect(rowsByArticleAndColumn.get(`article-with-cells:${llmYesColumnId}`)?.sourceProjectId).toBeNull()
  expect(rowsByArticleAndColumn.get(`article-with-cells:${llmYesColumnId}`)?.columnOrder).toBe(0)
  expect(rowsByArticleAndColumn.get(`article-with-cells:${llmArrayColumnId}`)?.columnOrder).toBe(2)
  expect(rowsByArticleAndColumn.get(`article-with-cells:${humanPromptAColumnId}`)?.columnOrder).toBe(4)
})

const getMaterializedModelOrderScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getComparisonProjectServingCellBuilder} = await import('./src/server/services/comparisonProjectServingCellBuilder.ts')
    const {ensureComparisonProjectServingGenerationConfig} = await import('./src/server/services/comparisonProjectServingGenerationConfig.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingCellBuilder()
    const selectedProjectId = 'comparison-materialized-selected-order'
    const discoveredProjectId = 'comparison-materialized-discovered-order'
    const runner = {queryJson: database.queryJson, run: database.run}

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-materialized-model-order', 'sglang', 'Provider Materialized Order', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES
        ('model-a', 'provider-materialized-model-order', 'Alpha Model', 'model-a', 'Alpha Model', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-materialized-model-order', 'Beta Model', 'model-b', 'Beta Model', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES ('prompt-materialized-order', 'Prompt Order', 'Prompt Order', NULL, 'prompt-materialized-order-hash', TIMESTAMPTZ '2026-05-01T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_created_at,
        article_updated_at
      ) VALUES
        ('article-selected-order', 'article-selected-order', 'Selected Order', 'Selected summary', TIMESTAMPTZ '2026-05-01T00:00:00.000Z', TIMESTAMPTZ '2026-05-01T01:00:00.000Z'),
        ('article-discovered-order', 'article-discovered-order', 'Discovered Order', 'Discovered summary', TIMESTAMPTZ '2026-05-02T00:00:00.000Z', TIMESTAMPTZ '2026-05-02T01:00:00.000Z')
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
        ('\${selectedProjectId}', 'Selected Order', NULL, ['model-b', 'model-a'], FALSE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('\${discoveredProjectId}', 'Discovered Order', NULL, []::VARCHAR[], FALSE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
      VALUES
        ('comparison-selected-order-prompt', '\${selectedProjectId}', 'prompt-materialized-order', 0),
        ('comparison-discovered-order-prompt', '\${discoveredProjectId}', 'prompt-materialized-order', 0)
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
        created_at,
        updated_at
      ) VALUES
        ('judgment-selected-model-a', 'article-selected-order', 'prompt-materialized-order', 'model-a', NULL, TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-05-03T00:00:00.000Z', TIMESTAMPTZ '2026-05-03T01:00:00.000Z'),
        ('judgment-selected-model-b', 'article-selected-order', 'prompt-materialized-order', 'model-b', NULL, TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-05-03T00:00:00.000Z', TIMESTAMPTZ '2026-05-03T01:00:00.000Z'),
        ('judgment-discovered-model-a', 'article-discovered-order', 'prompt-materialized-order', 'model-a', NULL, TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-05-03T00:00:00.000Z', TIMESTAMPTZ '2026-05-03T01:00:00.000Z'),
        ('judgment-discovered-model-b', 'article-discovered-order', 'prompt-materialized-order', 'model-b', NULL, TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-05-03T00:00:00.000Z', TIMESTAMPTZ '2026-05-03T01:00:00.000Z')
    \`)

    await ensureComparisonProjectServingGenerationConfig({comparisonProjectId: selectedProjectId, generation: 1}, runner)
    await ensureComparisonProjectServingGenerationConfig({comparisonProjectId: discoveredProjectId, generation: 1}, runner)

    await database.run(\`
      UPDATE app.comparison_project
      SET model_ids = ['model-a', 'model-b']
      WHERE id = '\${selectedProjectId}'
    \`)

    await database.run(\`
      UPDATE app.model
      SET name = CASE
        WHEN id = 'model-a' THEN 'Zulu Model'
        WHEN id = 'model-b' THEN 'Aardvark Model'
        ELSE name
      END
      WHERE id IN ('model-a', 'model-b')
    \`)

    await builder.insertPromptModeComparisonProjectCells({comparisonProjectId: selectedProjectId, generation: 1}, runner)
    await builder.insertPromptModeComparisonProjectCells({comparisonProjectId: discoveredProjectId, generation: 1}, runner)

    const actualRows = await database.queryJson(\`
      SELECT DISTINCT
        comparison_project_id AS comparisonProjectId,
        model_id AS modelId,
        CAST(column_order AS INTEGER) AS columnOrder
      FROM mart.comparison_cell_serving
      WHERE comparison_project_id IN ('\${selectedProjectId}', '\${discoveredProjectId}')
        AND generation = 1
        AND kind = 'llm'
      ORDER BY comparison_project_id ASC, column_order ASC
    \`)

    console.log(JSON.stringify({actualRows}))
  `
}

test('materialized prompt cell config keeps selected and discovered model order stable', () => {
  const result = runScript<MaterializedModelOrderResult>(getMaterializedModelOrderScript())

  expect(result.actualRows).toEqual([
    {columnOrder: 0, comparisonProjectId: 'comparison-materialized-discovered-order', modelId: 'model-a'},
    {columnOrder: 1, comparisonProjectId: 'comparison-materialized-discovered-order', modelId: 'model-b'},
    {columnOrder: 0, comparisonProjectId: 'comparison-materialized-selected-order', modelId: 'model-b'},
    {columnOrder: 1, comparisonProjectId: 'comparison-materialized-selected-order', modelId: 'model-a'},
  ])
})

const getSummaryModeServingCellsScript = () => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getComparisonProjectServingCellBuilder} = await import('./src/server/services/comparisonProjectServingCellBuilder.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const builder = getComparisonProjectServingCellBuilder()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-summary-cells', 'sglang', 'Provider Summary Cells', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES
        ('model-a', 'provider-summary-cells', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-summary-cells', 'Model B', 'model-b', 'Model B', 'manual', 'manual', TRUE, '{}'::JSON)
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
        use_fulltext_no_images
      ) VALUES
        ('source-project-a', 'Source Project A', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE),
        ('source-project-b', 'Source Project B', NULL, 'model-b', 'summary', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES
        ('prompt-a-include', 'Prompt A Include', 'Prompt A Include', NULL, 'prompt-a-include-hash', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
        ('prompt-a-exclude', 'Prompt A Exclude', 'Prompt A Exclude', NULL, 'prompt-a-exclude-hash', TIMESTAMPTZ '2026-04-02T00:00:00.000Z'),
        ('prompt-b-include', 'Prompt B Include', 'Prompt B Include', NULL, 'prompt-b-include-hash', TIMESTAMPTZ '2026-04-03T00:00:00.000Z'),
        ('prompt-b-exclude', 'Prompt B Exclude', 'Prompt B Exclude', NULL, 'prompt-b-exclude-hash', TIMESTAMPTZ '2026-04-04T00:00:00.000Z'),
        ('prompt-missing-metadata', 'Prompt Missing Metadata', 'Prompt Missing Metadata', NULL, 'prompt-missing-metadata-hash', TIMESTAMPTZ '2026-04-05T00:00:00.000Z')
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
        ('source-a-include', 'source-project-a', 'prompt-a-include', 0, TRUE, 'include', 'population', 'Population'),
        ('source-a-exclude', 'source-project-a', 'prompt-a-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion'),
        ('source-b-include', 'source-project-b', 'prompt-b-include', 0, TRUE, 'include', 'population', 'Population'),
        ('source-b-exclude', 'source-project-b', 'prompt-b-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion')
    \`)

    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_created_at,
        article_updated_at
      ) VALUES
        ('article-summary-yes', 'external-summary-yes', 'Article Summary Yes', 'Summary Yes', TIMESTAMPTZ '2026-04-10T00:00:00.000Z', TIMESTAMPTZ '2026-04-10T01:00:00.000Z'),
        ('article-summary-no-include', 'external-summary-no-include', 'Article Summary No Include', 'Summary No Include', TIMESTAMPTZ '2026-04-11T00:00:00.000Z', TIMESTAMPTZ '2026-04-11T01:00:00.000Z'),
        ('article-summary-no-exclude', 'external-summary-no-exclude', 'Article Summary No Exclude', 'Summary No Exclude', TIMESTAMPTZ '2026-04-12T00:00:00.000Z', TIMESTAMPTZ '2026-04-12T01:00:00.000Z'),
        ('article-summary-maybe', 'external-summary-maybe', 'Article Summary Maybe', 'Summary Maybe', TIMESTAMPTZ '2026-04-13T00:00:00.000Z', TIMESTAMPTZ '2026-04-13T01:00:00.000Z'),
        ('article-summary-missing', 'external-summary-missing', 'Article Summary Missing', 'Summary Missing', TIMESTAMPTZ '2026-04-14T00:00:00.000Z', TIMESTAMPTZ '2026-04-14T01:00:00.000Z'),
        ('article-summary-metadata', 'external-summary-metadata', 'Article Summary Metadata', 'Summary Metadata', TIMESTAMPTZ '2026-04-15T00:00:00.000Z', TIMESTAMPTZ '2026-04-15T01:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('source-a-article-yes', 'source-project-a', 'article-summary-yes'),
        ('source-a-article-no-include', 'source-project-a', 'article-summary-no-include'),
        ('source-a-article-no-exclude', 'source-project-a', 'article-summary-no-exclude'),
        ('source-a-article-maybe', 'source-project-a', 'article-summary-maybe'),
        ('source-a-article-missing', 'source-project-a', 'article-summary-missing'),
        ('source-b-article-yes', 'source-project-b', 'article-summary-yes')
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
        (
          '${summaryModeComparisonProjectId}',
          'Comparison Summary Cells',
          NULL,
          ['model-a', 'model-b'],
          TRUE,
          'summary',
          'source-project-a',
          TRUE,
          TRUE,
          FALSE,
          FALSE
        ),
        (
          '${missingMetadataComparisonProjectId}',
          'Comparison Summary Missing Metadata',
          NULL,
          ['model-a'],
          TRUE,
          'summary',
          'source-project-a',
          TRUE,
          TRUE,
          FALSE,
          FALSE
        )
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (
        id,
        comparison_project_id,
        prompt_id,
        prompt_order,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label
      ) VALUES
        ('comparison-summary-a-include', '${summaryModeComparisonProjectId}', 'prompt-a-include', 0, 'include', 'population', 'Population'),
        ('comparison-summary-a-exclude', '${summaryModeComparisonProjectId}', 'prompt-a-exclude', 1, 'exclude', 'exclusion', 'Exclusion'),
        ('comparison-missing-metadata', '${missingMetadataComparisonProjectId}', 'prompt-missing-metadata', 0, NULL, 'population', 'Population')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_source_project (
        id,
        comparison_project_id,
        source_project_id,
        created_at
      ) VALUES
        ('comparison-source-a', '${summaryModeComparisonProjectId}', 'source-project-a', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
        ('comparison-source-b', '${summaryModeComparisonProjectId}', 'source-project-b', TIMESTAMPTZ '2026-04-02T00:00:00.000Z')
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
        created_at,
        updated_at
      ) VALUES
        ('judgment-summary-a-yes-include', 'article-summary-yes', 'prompt-a-include', 'model-a', 'source-project-a', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-20T00:00:00.000Z', TIMESTAMPTZ '2026-04-20T01:00:00.000Z'),
        ('judgment-summary-a-yes-exclude', 'article-summary-yes', 'prompt-a-exclude', 'model-a', 'source-project-a', TRUE, 'no', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-20T00:00:00.000Z', TIMESTAMPTZ '2026-04-20T01:00:00.000Z'),
        ('judgment-summary-b-yes-include', 'article-summary-yes', 'prompt-b-include', 'model-b', 'source-project-b', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-20T00:00:00.000Z', TIMESTAMPTZ '2026-04-20T01:00:00.000Z'),
        ('judgment-summary-b-yes-exclude', 'article-summary-yes', 'prompt-b-exclude', 'model-b', 'source-project-b', TRUE, 'no', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-20T00:00:00.000Z', TIMESTAMPTZ '2026-04-20T01:00:00.000Z'),
        ('judgment-summary-no-include-include', 'article-summary-no-include', 'prompt-a-include', 'model-a', 'source-project-a', TRUE, 'no', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-21T00:00:00.000Z', TIMESTAMPTZ '2026-04-21T01:00:00.000Z'),
        ('judgment-summary-no-include-exclude', 'article-summary-no-include', 'prompt-a-exclude', 'model-a', 'source-project-a', TRUE, 'no', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-21T00:00:00.000Z', TIMESTAMPTZ '2026-04-21T01:00:00.000Z'),
        ('judgment-summary-no-exclude-include', 'article-summary-no-exclude', 'prompt-a-include', 'model-a', 'source-project-a', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-22T00:00:00.000Z', TIMESTAMPTZ '2026-04-22T01:00:00.000Z'),
        ('judgment-summary-no-exclude-exclude', 'article-summary-no-exclude', 'prompt-a-exclude', 'model-a', 'source-project-a', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-22T00:00:00.000Z', TIMESTAMPTZ '2026-04-22T01:00:00.000Z'),
        ('judgment-summary-maybe-include', 'article-summary-maybe', 'prompt-a-include', 'model-a', 'source-project-a', TRUE, 'unclear', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-23T00:00:00.000Z', TIMESTAMPTZ '2026-04-23T01:00:00.000Z'),
        ('judgment-summary-maybe-exclude', 'article-summary-maybe', 'prompt-a-exclude', 'model-a', 'source-project-a', TRUE, 'no', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-23T00:00:00.000Z', TIMESTAMPTZ '2026-04-23T01:00:00.000Z'),
        ('judgment-summary-missing-include', 'article-summary-missing', 'prompt-a-include', 'model-a', 'source-project-a', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-24T00:00:00.000Z', TIMESTAMPTZ '2026-04-24T01:00:00.000Z'),
        ('judgment-summary-metadata', 'article-summary-metadata', 'prompt-missing-metadata', 'model-a', 'source-project-a', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-25T00:00:00.000Z', TIMESTAMPTZ '2026-04-25T01:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin, created_at, updated_at)
      VALUES
        ('human-summary-yes-source-a', 'source-project-a', 'article-summary-yes', 'maybe', 'manual_override', TIMESTAMPTZ '2026-04-26T00:00:00.000Z', TIMESTAMPTZ '2026-04-26T01:00:00.000Z'),
        ('human-summary-no-source-a', 'source-project-a', 'article-summary-no-include', 'no', 'manual_override', TIMESTAMPTZ '2026-04-27T00:00:00.000Z', TIMESTAMPTZ '2026-04-27T01:00:00.000Z'),
        ('human-summary-ignored-source-b', 'source-project-b', 'article-summary-yes', 'no', 'manual_override', TIMESTAMPTZ '2026-04-28T00:00:00.000Z', TIMESTAMPTZ '2026-04-28T01:00:00.000Z')
    \`)

    await builder.insertSummaryModeComparisonProjectCells(
      {comparisonProjectId: '${summaryModeComparisonProjectId}', generation: 1},
      {queryJson: database.queryJson, run: database.run},
    )
    await builder.insertSummaryModeComparisonProjectLlmCells(
      {comparisonProjectId: '${missingMetadataComparisonProjectId}', generation: 1},
      {queryJson: database.queryJson, run: database.run},
    )

    const actualRows = await database.queryJson(\`
      SELECT
        comparison_project_id AS comparisonProjectId,
        article_id AS articleId,
        column_id AS columnId,
        CAST(column_order AS INTEGER) AS columnOrder,
        kind,
        prompt_id AS promptId,
        model_id AS modelId,
        source_project_id AS sourceProjectId,
        content_key AS contentKey,
        display_answer AS displayAnswer,
        TO_JSON(normalized_answers) AS normalizedAnswersJson
      FROM mart.comparison_cell_serving
      WHERE generation = 1
      ORDER BY comparison_project_id ASC, article_id ASC, column_order ASC, column_id ASC
    \`)

    const getJsonValue = (value) => {
      return typeof value === 'string' ? JSON.parse(value) : value
    }
    const normalizedRows = actualRows.map((row) => {
      return {...row, normalizedAnswers: getJsonValue(row.normalizedAnswersJson)}
    })

    console.log(JSON.stringify({actualRows: normalizedRows}))
  `
}

test('summary-mode serving cells derive LLM summaries and normalized human summaries', () => {
  const result = runScript<SummaryModeServingCellsResult>(getSummaryModeServingCellsScript())
  const sourceAColumnId = getComparisonProjectColumnId(
    'llm',
    summaryPromptId,
    'model-a',
    contentKey,
    'source-project-a',
  )
  const sourceBColumnId = getComparisonProjectColumnId(
    'llm',
    summaryPromptId,
    'model-b',
    contentKey,
    'source-project-b',
  )
  const fallbackColumnId = getComparisonProjectColumnId('llm', summaryPromptId, 'model-a', contentKey)
  const humanSummaryColumnId = getComparisonProjectColumnId('human', summaryPromptId)
  const rowsByProjectArticleAndColumn = result.actualRows.reduce<Map<string, ActualServingCellRow>>((rowMap, row) => {
    rowMap.set(`${row.comparisonProjectId}:${row.articleId}:${row.columnId}`, row)
    return rowMap
  }, new Map<string, ActualServingCellRow>())
  const summaryRows = result.actualRows.filter((row) => {
    return row.comparisonProjectId === summaryModeComparisonProjectId
  })
  const summaryCells = getActualCellsByArticle(summaryRows)

  expect(summaryCells['article-summary-yes']?.[sourceAColumnId]).toBe('yes')
  expect(summaryCells['article-summary-yes']?.[sourceBColumnId]).toBe('yes')
  expect(summaryCells['article-summary-no-include']?.[sourceAColumnId]).toBe('no')
  expect(summaryCells['article-summary-no-exclude']?.[sourceAColumnId]).toBe('no')
  expect(summaryCells['article-summary-maybe']?.[sourceAColumnId]).toBe('maybe')
  expect(summaryCells['article-summary-missing']?.[sourceAColumnId]).toBeUndefined()
  expect(summaryCells['article-summary-yes']?.[humanSummaryColumnId]).toBe('maybe')
  expect(summaryCells['article-summary-no-include']?.[humanSummaryColumnId]).toBe('no')
  expect(
    rowsByProjectArticleAndColumn.get(
      `${missingMetadataComparisonProjectId}:article-summary-metadata:${fallbackColumnId}`,
    ),
  ).toBeUndefined()
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-yes:${sourceAColumnId}`)
      ?.normalizedAnswers,
  ).toEqual(['yes'])
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-maybe:${sourceAColumnId}`)
      ?.normalizedAnswers,
  ).toEqual(['maybe'])
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-yes:${humanSummaryColumnId}`)
      ?.normalizedAnswers,
  ).toEqual(['maybe'])
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-yes:${sourceAColumnId}`)
      ?.sourceProjectId,
  ).toBe('source-project-a')
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-yes:${sourceAColumnId}`)
      ?.columnOrder,
  ).toBe(0)
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-yes:${sourceBColumnId}`)
      ?.columnOrder,
  ).toBe(1)
  expect(
    rowsByProjectArticleAndColumn.get(`${summaryModeComparisonProjectId}:article-summary-yes:${humanSummaryColumnId}`)
      ?.columnOrder,
  ).toBe(2)
})

test('generated cell insert SQL constrains source rows by article_batch', () => {
  const params = {
    articleIds: ['article-a', 'article-b'],
    comparisonProjectId: 'comparison-serving-batched-cell-sql',
    generation: 1,
  }
  const statements = [
    {
      joinSql: 'INNER JOIN article_batch ON article_batch.article_id = j.article_id',
      sql: getPromptModeComparisonProjectLlmCellServingInsertSql(params),
    },
    {
      joinSql: 'INNER JOIN article_batch ON article_batch.article_id = h.article_id',
      sql: getPromptModeComparisonProjectHumanCellServingInsertSql(params),
    },
    {
      joinSql: 'INNER JOIN article_batch ON article_batch.article_id = j.article_id',
      sql: getSummaryModeComparisonProjectLlmCellServingInsertSql(params),
    },
    {
      joinSql: 'INNER JOIN article_batch ON article_batch.article_id = h.article_id',
      sql: getSummaryModeComparisonProjectHumanCellServingInsertSql(params),
    },
  ]

  expect(
    statements.map(({joinSql, sql}) => {
      return {
        hasArticleA: sql.includes("('article-a')"),
        hasArticleB: sql.includes("('article-b')"),
        hasBatchCte: sql.includes('article_batch(article_id) AS ('),
        hasBatchJoin: sql.includes(joinSql),
      }
    }),
  ).toEqual([
    {hasArticleA: true, hasArticleB: true, hasBatchCte: true, hasBatchJoin: true},
    {hasArticleA: true, hasArticleB: true, hasBatchCte: true, hasBatchJoin: true},
    {hasArticleA: true, hasArticleB: true, hasBatchCte: true, hasBatchJoin: true},
    {hasArticleA: true, hasArticleB: true, hasBatchCte: true, hasBatchJoin: true},
  ])
})

test('prompt-mode cell inserts are split by discovered article batches', async () => {
  const queryStatements: string[] = []
  const statements: string[] = []
  const queryResults = [getArticleBatchRows(0, 251), getArticleBatchRows(250, 251)]
  const builder = getComparisonProjectServingCellBuilder()

  await builder.insertPromptModeComparisonProjectCells(
    {comparisonProjectId: 'comparison-serving-batched-cell-project', generation: 1},
    {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        queryStatements.push(statement)

        return statement.includes('SELECT scoped_article.article_id AS articleId')
          ? ((queryResults.shift() ?? []) as T[])
          : ([] as T[])
      },
      run: async (statement) => {
        statements.push(statement)
      },
    },
  )

  const batchQueryStatements = queryStatements.filter((statement) => {
    return statement.includes('SELECT scoped_article.article_id AS articleId')
  })
  const cellInsertStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.comparison_cell_serving')
  })

  expect(batchQueryStatements).toHaveLength(2)
  expect(batchQueryStatements[0]).toContain('LIMIT 251')
  expect(batchQueryStatements[1]).toContain("WHERE scoped_article.article_id > 'article-0249'")
  expect(
    statements.some((statement) => {
      return statement.includes('comparison_serving_generation_model_config')
    }),
  ).toBe(true)
  expect(cellInsertStatements).toHaveLength(4)
  expect(cellInsertStatements[0]).toContain("('article-0000')")
  expect(cellInsertStatements[0]).not.toContain("('article-0250')")
  expect(cellInsertStatements[2]).toContain("('article-0250')")
  expect(
    cellInsertStatements.map((statement) => {
      return statement.includes('article_batch(article_id) AS (')
    }),
  ).toEqual([true, true, true, true])
})

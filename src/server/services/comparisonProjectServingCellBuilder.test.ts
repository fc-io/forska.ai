import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  type ComparisonProjectJudgmentHumanRow,
  type ComparisonProjectJudgmentLlmRow,
  getComparisonProjectBatchCellsByArticle,
  getComparisonProjectColumnId,
  getComparisonProjectContentKey,
} from '../routes/comparisonProjectsRoutes/comparisonProjectJudgmentRows.ts'

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

const comparisonProjectId = 'comparison-project-prompt-cells'
const contentSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
const contentKey = getComparisonProjectContentKey(contentSettings)

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
      {run: database.run},
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

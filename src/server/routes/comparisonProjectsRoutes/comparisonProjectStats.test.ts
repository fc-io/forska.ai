import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  type ComparisonProjectStatsAggregateRow,
  type ComparisonProjectStatsCellRow,
  type ComparisonProjectStatsColumn,
  type ComparisonProjectStatsComparison,
  type ComparisonProjectStatsResolvedTruthComparison,
  getComparisonProjectAdditionalStats,
  getComparisonProjectAdditionalStatsFromCells,
  getComparisonProjectStats,
  getComparisonProjectStatsFromCells,
} from './comparisonProjectStats.ts'

const humanPromptColumn = {
  id: 'human:prompt-1',
  kind: 'human',
  modelId: null,
  modelLabel: 'Human',
  promptId: 'prompt-1',
  promptLabel: 'Prompt 1',
  sourceProjectId: null,
  sourceProjectName: null,
} satisfies ComparisonProjectStatsColumn

const primaryPromptColumn = {
  id: 'llm:model-1:1100:prompt-1',
  kind: 'llm',
  modelId: 'model-1',
  modelLabel: 'Model 1',
  promptId: 'prompt-1',
  promptLabel: 'Prompt 1',
  sourceProjectId: 'source-project-1',
  sourceProjectName: 'Primary project',
} satisfies ComparisonProjectStatsColumn

const peerPromptColumn = {
  id: 'llm:model-2:1100:prompt-1',
  kind: 'llm',
  modelId: 'model-2',
  modelLabel: 'Model 2',
  promptId: 'prompt-1',
  promptLabel: 'Prompt 1',
  sourceProjectId: 'source-project-2',
  sourceProjectName: 'Peer project',
} satisfies ComparisonProjectStatsColumn

const humanSummaryColumn = {
  id: 'human:summary',
  kind: 'human',
  modelId: null,
  modelLabel: 'Human',
  promptId: 'summary',
  promptLabel: 'Overall decision',
  sourceProjectId: 'source-project-1',
  sourceProjectName: 'Primary project',
} satisfies ComparisonProjectStatsColumn

const primarySummaryColumn = {
  id: 'llm:source-project-1:model-1:1100:summary',
  kind: 'llm',
  modelId: 'model-1',
  modelLabel: 'Model 1',
  promptId: 'summary',
  promptLabel: 'Overall decision',
  sourceProjectId: 'source-project-1',
  sourceProjectName: 'Primary project',
} satisfies ComparisonProjectStatsColumn

const peerSummaryColumn = {
  id: 'llm:source-project-2:model-2:1100:summary',
  kind: 'llm',
  modelId: 'model-2',
  modelLabel: 'Model 2',
  promptId: 'summary',
  promptLabel: 'Overall decision',
  sourceProjectId: 'source-project-2',
  sourceProjectName: 'Peer project',
} satisfies ComparisonProjectStatsColumn

const peerSummarySharedModelColumn = {
  ...peerSummaryColumn,
  id: 'llm:source-project-2:model-1:1100:summary',
  modelId: 'model-1',
  modelLabel: 'Model 1',
} satisfies ComparisonProjectStatsColumn

const getCell = (
  articleId: string,
  columnId: string,
  normalizedAnswers: string[] | string,
): ComparisonProjectStatsCellRow => {
  return {articleId, columnId, normalizedAnswers}
}

const findComparison = (
  comparisons: readonly ComparisonProjectStatsComparison[],
  kind: ComparisonProjectStatsComparison['kind'],
  rightColumnId?: string,
) => {
  const comparison = comparisons.find((candidate) => {
    return candidate.kind === kind && (!rightColumnId || candidate.rightColumnId === rightColumnId)
  })

  if (!comparison) {
    throw new Error(`Missing comparison ${kind}`)
  }

  return comparison
}

const findResolvedTruthComparison = (
  comparisons: readonly ComparisonProjectStatsResolvedTruthComparison[],
  llmColumnId: string,
) => {
  const comparison = comparisons.find((candidate) => {
    return candidate.llmColumnId === llmColumnId
  })

  if (!comparison) {
    throw new Error(`Missing resolved truth comparison ${llmColumnId}`)
  }

  return comparison
}

const getComparisonId = (
  kind: ComparisonProjectStatsComparison['kind'],
  leftColumnId: string,
  rightColumnId: string,
) => {
  return `${kind}:${leftColumnId}:${rightColumnId}`
}

test('comparison stats returns no comparisons without an active serving generation', async () => {
  const statements: string[] = []
  const comparisons = await getComparisonProjectStats({
    columns: [humanPromptColumn, primaryPromptColumn, peerPromptColumn],
    comparisonProjectId: 'comparison-project-1',
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)

        return []
      },
    },
  })

  expect(comparisons).toEqual([])
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain('FROM app.comparison_project_serving_generation')
  expect(statements[0]).not.toContain('FROM mart.comparison_cell_serving')
})

test('comparison stats reads compact aggregate rows from SQL', async () => {
  const statements: string[] = []
  const primaryComparisonId = getComparisonId('primary-vs-human', humanPromptColumn.id, primaryPromptColumn.id)
  const comparisons = await getComparisonProjectStats({
    columns: [humanPromptColumn, primaryPromptColumn],
    comparisonProjectId: 'comparison-project-1',
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        statements.push(statement)

        return statement.includes('FROM app.comparison_project_serving_generation')
          ? ([{generation: 1}] as T[])
          : ([
              {
                agreementCount: 0,
                binaryPairCount: 0,
                comparisonId: primaryComparisonId,
                conflictCount: 3,
                leftExcludeCount: 0,
                leftExcludeRightExcludeCount: 0,
                leftIncludeCount: 0,
                leftIncludeRightIncludeCount: 0,
                overlapCount: 4,
                rightExcludeCount: 0,
                rightIncludeCount: 0,
                trueConflictCount: 1,
              } satisfies ComparisonProjectStatsAggregateRow,
            ] as T[])
      },
    },
  })
  const aggregateStatement = statements[1] ?? ''
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primaryPromptColumn.id)

  expect(primaryComparison).toMatchObject({conflictCount: 3, overlapCount: 4, trueConflictCount: 1})
  expect(aggregateStatement).toContain('FROM mart.comparison_cell_serving cell')
  expect(aggregateStatement).toContain('GROUP BY comparison_id')
  expect(aggregateStatement).not.toContain('TO_JSON(cell.normalized_answers)')
  expect(aggregateStatement).not.toContain('normalizedAnswers')
})

test('comparison stats computes summary kappa from SQL aggregates', async () => {
  const primaryComparisonId = getComparisonId('primary-vs-human', humanSummaryColumn.id, primarySummaryColumn.id)
  const comparisons = await getComparisonProjectStats({
    columns: [humanSummaryColumn, primarySummaryColumn],
    comparisonProjectId: 'comparison-project-1',
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        return statement.includes('FROM app.comparison_project_serving_generation')
          ? ([{generation: 1}] as T[])
          : ([
              {
                agreementCount: 4,
                binaryPairCount: 6,
                comparisonId: primaryComparisonId,
                conflictCount: 3,
                leftExcludeCount: 3,
                leftExcludeRightExcludeCount: 2,
                leftIncludeCount: 3,
                leftIncludeRightIncludeCount: 2,
                overlapCount: 6,
                rightExcludeCount: 3,
                rightIncludeCount: 3,
                trueConflictCount: 2,
              } satisfies ComparisonProjectStatsAggregateRow,
            ] as T[])
      },
    },
  })
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primarySummaryColumn.id)

  expect(primaryComparison.overlapCount).toBe(6)
  expect(primaryComparison.conflictCount).toBe(3)
  expect(primaryComparison.trueConflictCount).toBe(2)
  expect(primaryComparison.cohensKappa).toBeCloseTo(1 / 3, 6)
  expect(primaryComparison.sensitivity).toBeCloseTo(2 / 3, 6)
  expect(primaryComparison.specificity).toBeCloseTo(2 / 3, 6)
})

test('comparison stats computes no-fallback human conflict resolution kappa from SQL aggregates with multiple summary LLMs', async () => {
  const humanConflictResolutionComparisonId = getComparisonId(
    'human-vs-conflict-resolution',
    humanSummaryColumn.id,
    humanSummaryColumn.id,
  )
  const comparisons = await getComparisonProjectStats({
    allowConflictResolution: true,
    columns: [humanSummaryColumn, primarySummaryColumn, peerSummaryColumn],
    comparisonProjectId: 'comparison-project-1',
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
    queryRunner: {
      queryJson: async <T>(statement: string): Promise<T[]> => {
        return statement.includes('FROM app.comparison_project_serving_generation')
          ? ([{generation: 1}] as T[])
          : ([
              {
                agreementCount: 2,
                binaryPairCount: 3,
                comparisonId: humanConflictResolutionComparisonId,
                conflictCount: 1,
                leftExcludeCount: 1,
                leftExcludeRightExcludeCount: 1,
                leftIncludeCount: 2,
                leftIncludeRightIncludeCount: 1,
                overlapCount: 3,
                rightExcludeCount: 2,
                rightIncludeCount: 1,
                trueConflictCount: 1,
              } satisfies ComparisonProjectStatsAggregateRow,
            ] as T[])
      },
    },
  })
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primarySummaryColumn.id)
  const humanConflictResolutionComparison = findComparison(
    comparisons,
    'human-vs-conflict-resolution',
    humanSummaryColumn.id,
  )

  expect(primaryComparison.cohensKappa).toBeNull()
  expect(humanConflictResolutionComparison.cohensKappa).toBeCloseTo(0.4, 6)
})

test('comparison stats SQL matches helper for no-fallback conflict resolution metrics', async () => {
  const cellRows = [
    getCell('article-1', humanSummaryColumn.id, ['yes']),
    getCell('article-1', primarySummaryColumn.id, ['no']),
    getCell('article-2', humanSummaryColumn.id, ['no']),
    getCell('article-2', primarySummaryColumn.id, ['yes']),
    getCell('article-3', humanSummaryColumn.id, ['no']),
    getCell('article-3', primarySummaryColumn.id, ['no']),
    getCell('article-4', humanSummaryColumn.id, ['yes']),
    getCell('article-4', primarySummaryColumn.id, ['yes']),
    getCell('article-5', humanSummaryColumn.id, ['yes']),
    getCell('article-5', primarySummaryColumn.id, ['yes']),
    getCell('article-6', humanSummaryColumn.id, ['unclear']),
    getCell('article-6', primarySummaryColumn.id, ['yes']),
    getCell('article-7', primarySummaryColumn.id, ['yes']),
  ]
  const conflictResolutionRows = [
    {answerValue: 'yes', articleId: 'article-1'},
    {answerValue: 'maybe', articleId: 'article-2'},
    {answerValue: 'no', articleId: 'article-3'},
    {answerValue: 'unclear', articleId: 'article-5'},
    {answerValue: 'yes', articleId: 'article-6'},
    {answerValue: 'yes', articleId: 'article-7'},
  ]
  const expectedComparisons = getComparisonProjectStatsFromCells({
    allowConflictResolution: true,
    cellRows,
    columns: [humanSummaryColumn, primarySummaryColumn],
    conflictResolutionRows,
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`SET memory_limit = '1GB'`)
    await connection.run(`CREATE SCHEMA app`)
    await connection.run(`CREATE SCHEMA mart`)
    await connection.run(`
      CREATE TABLE app.comparison_project_serving_generation (
        comparison_project_id VARCHAR,
        active_generation INTEGER
      )
    `)
    await connection.run(`
      CREATE TABLE mart.comparison_cell_serving (
        comparison_project_id VARCHAR,
        generation INTEGER,
        article_id VARCHAR,
        column_id VARCHAR,
        normalized_answers VARCHAR[]
      )
    `)
    await connection.run(`
      CREATE TABLE app.comparison_project_conflict_resolution (
        comparison_project_id VARCHAR,
        article_id VARCHAR,
        answer_value VARCHAR
      )
    `)
    await connection.run(`
      INSERT INTO app.comparison_project_serving_generation
      VALUES ('comparison-project-1', 1)
    `)
    await connection.run(`
      INSERT INTO mart.comparison_cell_serving
      VALUES
        ('comparison-project-1', 1, 'article-1', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-1', '${primarySummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-2', '${humanSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-2', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-3', '${humanSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-3', '${primarySummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-4', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-4', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-5', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-5', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-6', '${humanSummaryColumn.id}', ['unclear']),
        ('comparison-project-1', 1, 'article-6', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-7', '${primarySummaryColumn.id}', ['yes'])
    `)
    await connection.run(`
      INSERT INTO app.comparison_project_conflict_resolution
      VALUES
        ('comparison-project-1', 'article-1', 'yes'),
        ('comparison-project-1', 'article-2', 'maybe'),
        ('comparison-project-1', 'article-3', 'no'),
        ('comparison-project-1', 'article-5', 'unclear'),
        ('comparison-project-1', 'article-6', 'yes'),
        ('comparison-project-1', 'article-7', 'yes')
    `)

    const comparisons = await getComparisonProjectStats({
      allowConflictResolution: true,
      columns: [humanSummaryColumn, primarySummaryColumn],
      comparisonProjectId: 'comparison-project-1',
      isSummaryMode: true,
      primarySourceProjectId: 'source-project-1',
      queryRunner: {
        queryJson: async <T>(statement: string): Promise<T[]> => {
          const reader = await connection.runAndReadAll(statement)

          return reader.getRowObjectsJson() as T[]
        },
      },
    })
    const primaryComparison = findComparison(comparisons, 'primary-vs-human', primarySummaryColumn.id)
    const expectedPrimaryComparison = findComparison(expectedComparisons, 'primary-vs-human', primarySummaryColumn.id)
    const conflictResolutionComparison = findComparison(
      comparisons,
      'llm-vs-conflict-resolution',
      primarySummaryColumn.id,
    )
    const expectedConflictResolutionComparison = findComparison(
      expectedComparisons,
      'llm-vs-conflict-resolution',
      primarySummaryColumn.id,
    )
    const humanConflictResolutionComparison = findComparison(
      comparisons,
      'human-vs-conflict-resolution',
      humanSummaryColumn.id,
    )
    const expectedHumanConflictResolutionComparison = findComparison(
      expectedComparisons,
      'human-vs-conflict-resolution',
      humanSummaryColumn.id,
    )

    expect(primaryComparison).toMatchObject({
      conflictCount: expectedPrimaryComparison.conflictCount,
      overlapCount: expectedPrimaryComparison.overlapCount,
      sensitivity: expectedPrimaryComparison.sensitivity,
      specificity: expectedPrimaryComparison.specificity,
      trueConflictCount: expectedPrimaryComparison.trueConflictCount,
    })
    expect(primaryComparison.cohensKappa).toBeCloseTo(expectedPrimaryComparison.cohensKappa ?? 0, 6)
    expect(conflictResolutionComparison).toMatchObject({
      conflictCount: expectedConflictResolutionComparison.conflictCount,
      label: 'Model 1 vs Conflict resolution (fallback to human answer if no resolution provided)',
      overlapCount: expectedConflictResolutionComparison.overlapCount,
      sensitivity: expectedConflictResolutionComparison.sensitivity,
      specificity: expectedConflictResolutionComparison.specificity,
      trueConflictCount: expectedConflictResolutionComparison.trueConflictCount,
    })
    expect(conflictResolutionComparison.cohensKappa).toBeCloseTo(
      expectedConflictResolutionComparison.cohensKappa ?? 0,
      6,
    )
    expect(conflictResolutionComparison.overlapCount).toBe(6)
    expect(humanConflictResolutionComparison).toMatchObject({
      conflictCount: expectedHumanConflictResolutionComparison.conflictCount,
      label: 'Human vs Conflict resolution (no fallback)',
      overlapCount: expectedHumanConflictResolutionComparison.overlapCount,
      sensitivity: expectedHumanConflictResolutionComparison.sensitivity,
      specificity: expectedHumanConflictResolutionComparison.specificity,
      trueConflictCount: expectedHumanConflictResolutionComparison.trueConflictCount,
    })
    expect(humanConflictResolutionComparison.overlapCount).toBe(3)
    expect(humanConflictResolutionComparison.conflictCount).toBe(1)
    expect(humanConflictResolutionComparison.trueConflictCount).toBe(1)
    expect(humanConflictResolutionComparison.cohensKappa).toBeCloseTo(
      expectedHumanConflictResolutionComparison.cohensKappa ?? 0,
      6,
    )
    expect(humanConflictResolutionComparison.cohensKappa).toBeCloseTo(0.4, 6)
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('additional stats SQL matches helper for no-fallback head-to-head truth metrics', async () => {
  const cellRows = [
    getCell('article-1', humanSummaryColumn.id, ['yes']),
    getCell('article-1', primarySummaryColumn.id, ['yes']),
    getCell('article-1', peerSummaryColumn.id, ['no']),
    getCell('article-2', humanSummaryColumn.id, ['yes']),
    getCell('article-2', primarySummaryColumn.id, ['no']),
    getCell('article-2', peerSummaryColumn.id, ['no']),
    getCell('article-3', humanSummaryColumn.id, ['no']),
    getCell('article-3', primarySummaryColumn.id, ['no']),
    getCell('article-3', peerSummaryColumn.id, ['yes']),
    getCell('article-4', humanSummaryColumn.id, ['no']),
    getCell('article-4', primarySummaryColumn.id, ['yes']),
    getCell('article-4', peerSummaryColumn.id, ['yes']),
    getCell('article-5', humanSummaryColumn.id, ['maybe']),
    getCell('article-5', primarySummaryColumn.id, ['no']),
    getCell('article-5', peerSummaryColumn.id, ['yes']),
    getCell('article-6', humanSummaryColumn.id, ['yes']),
    getCell('article-6', primarySummaryColumn.id, ['yes']),
    getCell('article-6', peerSummaryColumn.id, ['yes']),
    getCell('article-7', humanSummaryColumn.id, ['yes']),
    getCell('article-7', primarySummaryColumn.id, ['yes']),
    getCell('article-7', peerSummaryColumn.id, ['yes']),
    getCell('article-8', humanSummaryColumn.id, ['unclear']),
    getCell('article-8', primarySummaryColumn.id, ['yes']),
    getCell('article-8', peerSummaryColumn.id, ['yes']),
    getCell('article-9', humanSummaryColumn.id, ['no']),
    getCell('article-9', primarySummaryColumn.id, ['unclear']),
    getCell('article-9', peerSummaryColumn.id, ['no']),
  ]
  const conflictResolutionRows = [
    {answerValue: 'yes', articleId: 'article-1'},
    {answerValue: 'no', articleId: 'article-2'},
    {answerValue: 'yes', articleId: 'article-3'},
    {answerValue: 'no', articleId: 'article-4'},
    {answerValue: 'maybe', articleId: 'article-5'},
    {answerValue: 'unclear', articleId: 'article-7'},
    {answerValue: 'yes', articleId: 'article-8'},
    {answerValue: 'no', articleId: 'article-9'},
  ]
  const expectedAdditionalStats = getComparisonProjectAdditionalStatsFromCells({
    allowConflictResolution: true,
    cellRows,
    columns: [humanSummaryColumn, primarySummaryColumn, peerSummaryColumn],
    conflictResolutionRows,
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`SET memory_limit = '1GB'`)
    await connection.run(`CREATE SCHEMA app`)
    await connection.run(`CREATE SCHEMA mart`)
    await connection.run(`
      CREATE TABLE app.comparison_project_serving_generation (
        comparison_project_id VARCHAR,
        active_generation INTEGER
      )
    `)
    await connection.run(`
      CREATE TABLE mart.comparison_cell_serving (
        comparison_project_id VARCHAR,
        generation INTEGER,
        article_id VARCHAR,
        column_id VARCHAR,
        normalized_answers VARCHAR[]
      )
    `)
    await connection.run(`
      CREATE TABLE app.comparison_project_conflict_resolution (
        comparison_project_id VARCHAR,
        article_id VARCHAR,
        answer_value VARCHAR
      )
    `)
    await connection.run(`
      INSERT INTO app.comparison_project_serving_generation
      VALUES ('comparison-project-1', 1)
    `)
    await connection.run(`
      INSERT INTO mart.comparison_cell_serving
      VALUES
        ('comparison-project-1', 1, 'article-1', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-1', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-1', '${peerSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-2', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-2', '${primarySummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-2', '${peerSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-3', '${humanSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-3', '${primarySummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-3', '${peerSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-4', '${humanSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-4', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-4', '${peerSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-5', '${humanSummaryColumn.id}', ['maybe']),
        ('comparison-project-1', 1, 'article-5', '${primarySummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-5', '${peerSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-6', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-6', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-6', '${peerSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-7', '${humanSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-7', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-7', '${peerSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-8', '${humanSummaryColumn.id}', ['unclear']),
        ('comparison-project-1', 1, 'article-8', '${primarySummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-8', '${peerSummaryColumn.id}', ['yes']),
        ('comparison-project-1', 1, 'article-9', '${humanSummaryColumn.id}', ['no']),
        ('comparison-project-1', 1, 'article-9', '${primarySummaryColumn.id}', ['unclear']),
        ('comparison-project-1', 1, 'article-9', '${peerSummaryColumn.id}', ['no'])
    `)
    await connection.run(`
      INSERT INTO app.comparison_project_conflict_resolution
      VALUES
        ('comparison-project-1', 'article-1', 'yes'),
        ('comparison-project-1', 'article-2', 'no'),
        ('comparison-project-1', 'article-3', 'yes'),
        ('comparison-project-1', 'article-4', 'no'),
        ('comparison-project-1', 'article-5', 'maybe'),
        ('comparison-project-1', 'article-7', 'unclear'),
        ('comparison-project-1', 'article-8', 'yes'),
        ('comparison-project-1', 'article-9', 'no')
    `)

    const additionalStats = await getComparisonProjectAdditionalStats({
      allowConflictResolution: true,
      columns: [humanSummaryColumn, primarySummaryColumn, peerSummaryColumn],
      comparisonProjectId: 'comparison-project-1',
      isSummaryMode: true,
      primarySourceProjectId: 'source-project-1',
      queryRunner: {
        queryJson: async <T>(statement: string): Promise<T[]> => {
          const reader = await connection.runAndReadAll(statement)

          return reader.getRowObjectsJson() as T[]
        },
      },
    })
    const primaryComparison = findResolvedTruthComparison(
      additionalStats.resolvedTruthComparisons,
      primarySummaryColumn.id,
    )
    const peerComparison = findResolvedTruthComparison(additionalStats.resolvedTruthComparisons, peerSummaryColumn.id)

    expect(additionalStats).toEqual(expectedAdditionalStats)
    expect(primaryComparison).toMatchObject({
      bothCorrectCount: 1,
      bothWrongCount: 1,
      humanCorrectVsTruthCount: 3,
      humanErrorsVsTruthCount: 2,
      humanOnlyCorrectCount: 2,
      llmAdvantage: -1,
      llmCorrectVsTruthCount: 2,
      llmErrorsVsTruthCount: 3,
      llmOnlyCorrectCount: 1,
      mcnemarChiSquare: 0,
      resolvedCount: 5,
      winner: 'Human',
    })
    expect(primaryComparison.humanMetrics.accuracy).toBeCloseTo(3 / 5, 6)
    expect(primaryComparison.humanMetrics.balancedAccuracy).toBeCloseTo(7 / 12, 6)
    expect(primaryComparison.humanMetrics.precision).toBeCloseTo(2 / 3, 6)
    expect(primaryComparison.humanMetrics.negativePredictiveValue).toBeCloseTo(1 / 2, 6)
    expect(primaryComparison.humanMetrics.f1).toBeCloseTo(2 / 3, 6)
    expect(primaryComparison.humanMetrics.truthPrevalence).toBeCloseTo(3 / 5, 6)
    expect(primaryComparison.llmMetrics.accuracy).toBeCloseTo(2 / 5, 6)
    expect(primaryComparison.llmMetrics.balancedAccuracy).toBeCloseTo(5 / 12, 6)
    expect(primaryComparison.llmMetrics.precision).toBeCloseTo(1 / 2, 6)
    expect(primaryComparison.llmMetrics.negativePredictiveValue).toBeCloseTo(1 / 3, 6)
    expect(primaryComparison.llmMetrics.f1).toBeCloseTo(2 / 5, 6)
    expect(primaryComparison.llmMetrics.truthPrevalence).toBeCloseTo(3 / 5, 6)
    expect(peerComparison).toMatchObject({
      bothCorrectCount: 2,
      bothWrongCount: 0,
      humanCorrectVsTruthCount: 4,
      humanErrorsVsTruthCount: 2,
      humanOnlyCorrectCount: 2,
      llmAdvantage: 0,
      llmCorrectVsTruthCount: 4,
      llmErrorsVsTruthCount: 2,
      llmOnlyCorrectCount: 2,
      mcnemarChiSquare: 0.25,
      resolvedCount: 6,
      winner: 'Tie',
    })
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('additional stats returns null rates for zero denominators', () => {
  const additionalStats = getComparisonProjectAdditionalStatsFromCells({
    allowConflictResolution: true,
    cellRows: [
      getCell('article-1', humanSummaryColumn.id, ['no']),
      getCell('article-1', primarySummaryColumn.id, ['no']),
      getCell('article-2', humanSummaryColumn.id, ['no']),
      getCell('article-2', primarySummaryColumn.id, ['no']),
    ],
    columns: [humanSummaryColumn, primarySummaryColumn],
    conflictResolutionRows: [
      {answerValue: 'yes', articleId: 'article-1'},
      {answerValue: 'yes', articleId: 'article-2'},
    ],
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const comparison = findResolvedTruthComparison(additionalStats.resolvedTruthComparisons, primarySummaryColumn.id)

  expect(comparison).toMatchObject({
    bothCorrectCount: 0,
    bothWrongCount: 2,
    humanCorrectVsTruthCount: 0,
    humanErrorsVsTruthCount: 2,
    llmCorrectVsTruthCount: 0,
    llmErrorsVsTruthCount: 2,
    mcnemarChiSquare: null,
    resolvedCount: 2,
    winner: 'Tie',
  })
  expect(comparison.humanMetrics).toMatchObject({
    accuracy: 0,
    balancedAccuracy: null,
    f1: 0,
    negativePredictiveValue: 0,
    precision: null,
    specificity: null,
    truthPrevalence: 1,
  })
  expect(comparison.llmMetrics).toMatchObject({
    accuracy: 0,
    balancedAccuracy: null,
    f1: 0,
    negativePredictiveValue: 0,
    precision: null,
    specificity: null,
    truthPrevalence: 1,
  })
})

test('comparison stats builds primary, human-vs-llm, and llm-vs-llm groups', () => {
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows: [],
    columns: [humanPromptColumn, primaryPromptColumn, peerPromptColumn],
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
  })

  expect(
    comparisons.map((comparison) => {
      return {
        columnInfo: comparison.columnInfo,
        kind: comparison.kind,
        label: comparison.label,
        leftColumnId: comparison.leftColumnId,
        rightColumnId: comparison.rightColumnId,
      }
    }),
  ).toEqual([
    {
      columnInfo: null,
      kind: 'primary-vs-human',
      label: 'Model 1 - Prompt 1 vs Human - Prompt 1',
      leftColumnId: humanPromptColumn.id,
      rightColumnId: primaryPromptColumn.id,
    },
    {
      columnInfo: null,
      kind: 'human-vs-llm',
      label: 'Model 2 - Prompt 1 vs Human - Prompt 1',
      leftColumnId: humanPromptColumn.id,
      rightColumnId: peerPromptColumn.id,
    },
    {
      columnInfo: null,
      kind: 'llm-vs-llm',
      label: 'Model 1 - Prompt 1 vs Model 2 - Prompt 1',
      leftColumnId: primaryPromptColumn.id,
      rightColumnId: peerPromptColumn.id,
    },
  ])
})

test('comparison stats prefers primary source project over shared model id and disambiguates shared model labels', () => {
  const comparisons = getComparisonProjectStatsFromCells({
    allowConflictResolution: true,
    cellRows: [],
    columns: [humanSummaryColumn, primarySummaryColumn, peerSummarySharedModelColumn],
    isSummaryMode: true,
    primaryModelId: 'model-1',
    primarySourceProjectId: 'source-project-1',
  })

  expect(
    comparisons.map((comparison) => {
      return {
        columnInfo: comparison.columnInfo,
        kind: comparison.kind,
        label: comparison.label,
        leftColumnId: comparison.leftColumnId,
        rightColumnId: comparison.rightColumnId,
      }
    }),
  ).toEqual([
    {
      columnInfo: null,
      kind: 'primary-vs-human',
      label: 'Model 1 (Primary project) vs Human',
      leftColumnId: humanSummaryColumn.id,
      rightColumnId: primarySummaryColumn.id,
    },
    {
      columnInfo: null,
      kind: 'llm-vs-conflict-resolution',
      label: 'Model 1 (Primary project) vs Conflict resolution (fallback to human answer if no resolution provided)',
      leftColumnId: humanSummaryColumn.id,
      rightColumnId: primarySummaryColumn.id,
    },
    {
      columnInfo: null,
      kind: 'human-vs-llm',
      label: 'Model 1 (Peer project) vs Human',
      leftColumnId: humanSummaryColumn.id,
      rightColumnId: peerSummarySharedModelColumn.id,
    },
    {
      columnInfo: null,
      kind: 'llm-vs-conflict-resolution',
      label: 'Model 1 (Peer project) vs Conflict resolution (fallback to human answer if no resolution provided)',
      leftColumnId: humanSummaryColumn.id,
      rightColumnId: peerSummarySharedModelColumn.id,
    },
    {
      columnInfo: null,
      kind: 'human-vs-conflict-resolution',
      label: 'Human vs Conflict resolution (no fallback)',
      leftColumnId: humanSummaryColumn.id,
      rightColumnId: humanSummaryColumn.id,
    },
    {
      columnInfo: null,
      kind: 'llm-vs-llm',
      label: 'Model 1 (Primary project) vs Model 1 (Peer project)',
      leftColumnId: primarySummaryColumn.id,
      rightColumnId: peerSummarySharedModelColumn.id,
    },
  ])
})

test('comparison stats labels source-project summary comparisons with model name against human', () => {
  const projectName = 'cov | GPT 5.5 xhigh | 2.2'
  const modelName = 'GPT 5.5 xhigh | 2.2'
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows: [],
    columns: [
      {...humanSummaryColumn, sourceProjectName: projectName},
      {
        ...primarySummaryColumn,
        contentLabel: 'Article Title and Abstract',
        modelLabel: modelName,
        sourceProjectName: projectName,
      },
    ],
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primarySummaryColumn.id)

  expect(primaryComparison.label).toBe('GPT 5.5 xhigh | 2.2 vs Human')
  expect(primaryComparison.columnInfo).toBe('Article Title and Abstract')
})

test('comparison stats adds conflict resolution comparison with resolved answers', () => {
  const cellRows = [
    getCell('article-1', humanSummaryColumn.id, ['yes']),
    getCell('article-1', primarySummaryColumn.id, ['yes']),
    getCell('article-2', humanSummaryColumn.id, ['maybe']),
    getCell('article-2', primarySummaryColumn.id, ['yes']),
    getCell('article-3', humanSummaryColumn.id, ['no']),
    getCell('article-3', primarySummaryColumn.id, ['no']),
    getCell('article-4', humanSummaryColumn.id, ['no']),
    getCell('article-4', primarySummaryColumn.id, ['no']),
    getCell('article-5', humanSummaryColumn.id, ['maybe']),
    getCell('article-5', primarySummaryColumn.id, ['no']),
    getCell('article-6', humanSummaryColumn.id, ['no']),
    getCell('article-6', primarySummaryColumn.id, ['yes']),
  ]
  const comparisons = getComparisonProjectStatsFromCells({
    allowConflictResolution: true,
    cellRows,
    columns: [humanSummaryColumn, primarySummaryColumn],
    conflictResolutionRows: [
      {answerValue: 'no', articleId: 'article-5'},
      {answerValue: 'yes', articleId: 'article-6'},
    ],
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primarySummaryColumn.id)
  const conflictResolutionComparison = findComparison(
    comparisons,
    'llm-vs-conflict-resolution',
    primarySummaryColumn.id,
  )

  expect(primaryComparison.trueConflictCount).toBe(2)
  expect(conflictResolutionComparison).toMatchObject({
    conflictCount: 1,
    label: 'Model 1 vs Conflict resolution (fallback to human answer if no resolution provided)',
    overlapCount: 6,
    sensitivity: 1,
    specificity: 1,
    trueConflictCount: 0,
  })
  expect(conflictResolutionComparison.cohensKappa).toBe(1)
})

test('comparison stats adds no-fallback human conflict resolution comparison', () => {
  const cellRows = [
    getCell('article-1', humanSummaryColumn.id, ['yes']),
    getCell('article-1', primarySummaryColumn.id, ['no']),
    getCell('article-2', humanSummaryColumn.id, ['no']),
    getCell('article-2', primarySummaryColumn.id, ['yes']),
    getCell('article-3', humanSummaryColumn.id, ['no']),
    getCell('article-3', primarySummaryColumn.id, ['no']),
    getCell('article-4', humanSummaryColumn.id, ['yes']),
    getCell('article-4', primarySummaryColumn.id, ['yes']),
    getCell('article-5', humanSummaryColumn.id, ['yes']),
    getCell('article-5', primarySummaryColumn.id, ['yes']),
    getCell('article-6', humanSummaryColumn.id, ['unclear']),
    getCell('article-6', primarySummaryColumn.id, ['yes']),
  ]
  const comparisons = getComparisonProjectStatsFromCells({
    allowConflictResolution: true,
    cellRows,
    columns: [humanSummaryColumn, primarySummaryColumn, peerSummaryColumn],
    conflictResolutionRows: [
      {answerValue: 'yes', articleId: 'article-1'},
      {answerValue: 'maybe', articleId: 'article-2'},
      {answerValue: 'no', articleId: 'article-3'},
      {answerValue: 'unclear', articleId: 'article-5'},
      {answerValue: 'yes', articleId: 'article-6'},
    ],
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const fallbackConflictResolutionComparison = findComparison(
    comparisons,
    'llm-vs-conflict-resolution',
    primarySummaryColumn.id,
  )
  const humanConflictResolutionComparison = findComparison(
    comparisons,
    'human-vs-conflict-resolution',
    humanSummaryColumn.id,
  )

  expect(fallbackConflictResolutionComparison.overlapCount).toBe(6)
  expect(humanConflictResolutionComparison).toMatchObject({
    conflictCount: 1,
    label: 'Human vs Conflict resolution (no fallback)',
    overlapCount: 3,
    sensitivity: 0.5,
    specificity: 1,
    trueConflictCount: 1,
  })
  expect(humanConflictResolutionComparison.cohensKappa).toBeCloseTo(0.4, 6)
})

test('comparison stats counts llm-vs-llm overlaps and conflicts from normalized answers', () => {
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows: [
      getCell('article-1', primaryPromptColumn.id, ['yes']),
      getCell('article-1', peerPromptColumn.id, ['no']),
      getCell('article-2', primaryPromptColumn.id, ['maybe']),
      getCell('article-2', peerPromptColumn.id, ['yes']),
      getCell('article-3', primaryPromptColumn.id, ['no']),
      getCell('article-3', peerPromptColumn.id, ['no']),
      getCell('article-4', primaryPromptColumn.id, ['yes']),
    ],
    columns: [humanPromptColumn, primaryPromptColumn, peerPromptColumn],
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
  })
  const llmComparison = findComparison(comparisons, 'llm-vs-llm')

  expect(llmComparison).toMatchObject({
    cohensKappa: null,
    conflictCount: 2,
    overlapCount: 3,
    sensitivity: null,
    specificity: null,
    trueConflictCount: 1,
  })
})

test('comparison stats counts human-vs-llm conflicts from non-empty normalized answers', () => {
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows: [
      getCell('article-1', humanPromptColumn.id, ['yes']),
      getCell('article-1', peerPromptColumn.id, ['no']),
      getCell('article-2', humanPromptColumn.id, ['maybe']),
      getCell('article-2', peerPromptColumn.id, ['yes']),
      getCell('article-3', humanPromptColumn.id, ['no']),
      getCell('article-3', peerPromptColumn.id, ['no']),
      getCell('article-4', humanPromptColumn.id, ['yes']),
      getCell('article-4', peerPromptColumn.id, []),
    ],
    columns: [humanPromptColumn, primaryPromptColumn, peerPromptColumn],
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
  })
  const humanVsLlmComparison = findComparison(comparisons, 'human-vs-llm', peerPromptColumn.id)

  expect(humanVsLlmComparison).toMatchObject({
    cohensKappa: null,
    conflictCount: 2,
    overlapCount: 3,
    sensitivity: 0.5,
    specificity: 1,
    trueConflictCount: 1,
  })
})

test('comparison stats treats maybe as include for true conflicts', () => {
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows: [
      getCell('article-1', humanPromptColumn.id, ['maybe']),
      getCell('article-1', primaryPromptColumn.id, ['no']),
      getCell('article-2', humanPromptColumn.id, ['maybe']),
      getCell('article-2', primaryPromptColumn.id, ['yes']),
      getCell('article-3', humanPromptColumn.id, ['yes']),
      getCell('article-3', primaryPromptColumn.id, ['maybe']),
      getCell('article-4', humanPromptColumn.id, ['no']),
      getCell('article-4', primaryPromptColumn.id, ['no']),
    ],
    columns: [humanPromptColumn, primaryPromptColumn],
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
  })
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primaryPromptColumn.id)

  expect(primaryComparison).toMatchObject({
    conflictCount: 3,
    overlapCount: 4,
    sensitivity: 2 / 3,
    specificity: 1,
    trueConflictCount: 1,
  })
})

test('comparison stats computes summary-mode kappa only for exactly two summary raters', () => {
  const cellRows = [
    getCell('article-1', humanSummaryColumn.id, ['yes']),
    getCell('article-1', primarySummaryColumn.id, ['yes']),
    getCell('article-2', humanSummaryColumn.id, ['maybe']),
    getCell('article-2', primarySummaryColumn.id, ['yes']),
    getCell('article-3', humanSummaryColumn.id, ['no']),
    getCell('article-3', primarySummaryColumn.id, ['no']),
    getCell('article-4', humanSummaryColumn.id, ['no']),
    getCell('article-4', primarySummaryColumn.id, ['no']),
    getCell('article-5', humanSummaryColumn.id, ['maybe']),
    getCell('article-5', primarySummaryColumn.id, ['no']),
    getCell('article-6', humanSummaryColumn.id, ['no']),
    getCell('article-6', primarySummaryColumn.id, ['yes']),
  ]
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows,
    columns: [humanSummaryColumn, primarySummaryColumn],
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const primaryComparison = findComparison(comparisons, 'primary-vs-human', primarySummaryColumn.id)
  const multiRaterComparisons = getComparisonProjectStatsFromCells({
    cellRows,
    columns: [humanSummaryColumn, primarySummaryColumn, peerSummaryColumn],
    isSummaryMode: true,
    primarySourceProjectId: 'source-project-1',
  })
  const multiRaterPrimaryComparison = findComparison(multiRaterComparisons, 'primary-vs-human', primarySummaryColumn.id)

  expect(primaryComparison.overlapCount).toBe(6)
  expect(primaryComparison.conflictCount).toBe(3)
  expect(primaryComparison.trueConflictCount).toBe(2)
  expect(primaryComparison.cohensKappa).toBeCloseTo(1 / 3, 6)
  expect(primaryComparison.sensitivity).toBeCloseTo(2 / 3, 6)
  expect(primaryComparison.specificity).toBeCloseTo(2 / 3, 6)
  expect(multiRaterPrimaryComparison.cohensKappa).toBeNull()
  expect(multiRaterPrimaryComparison.sensitivity).toBeCloseTo(2 / 3, 6)
  expect(multiRaterPrimaryComparison.specificity).toBeCloseTo(2 / 3, 6)
})

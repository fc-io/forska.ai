import {expect, test} from 'bun:test'

import {
  type ComparisonProjectStatsCellRow,
  type ComparisonProjectStatsColumn,
  type ComparisonProjectStatsComparison,
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

test('comparison stats builds primary, human-vs-llm, and llm-vs-llm groups', () => {
  const comparisons = getComparisonProjectStatsFromCells({
    cellRows: [],
    columns: [humanPromptColumn, primaryPromptColumn, peerPromptColumn],
    isSummaryMode: false,
    primarySourceProjectId: 'source-project-1',
  })

  expect(
    comparisons.map((comparison) => {
      return {kind: comparison.kind, leftColumnId: comparison.leftColumnId, rightColumnId: comparison.rightColumnId}
    }),
  ).toEqual([
    {kind: 'primary-vs-human', leftColumnId: humanPromptColumn.id, rightColumnId: primaryPromptColumn.id},
    {kind: 'human-vs-llm', leftColumnId: humanPromptColumn.id, rightColumnId: peerPromptColumn.id},
    {kind: 'llm-vs-llm', leftColumnId: primaryPromptColumn.id, rightColumnId: peerPromptColumn.id},
  ])
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

  expect(llmComparison).toMatchObject({cohensKappa: null, conflictCount: 2, overlapCount: 3, trueConflictCount: 1})
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

  expect(primaryComparison).toMatchObject({conflictCount: 3, overlapCount: 4, trueConflictCount: 1})
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
  expect(multiRaterPrimaryComparison.cohensKappa).toBeNull()
})

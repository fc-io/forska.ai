// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, describe, expect, test} from 'vitest'

import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStats,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsComparison,
} from '../../../../../../services/comparisonProjectsService.ts'
import {ComparisonProjectChineseStatsSection} from './comparisonProjectChineseStatsSection.tsx'

const emptyAdditionalStats: ComparisonProjectAdditionalStats = {
  conflictResolutionAnswerComparisons: [],
  resolvedTruthComparisons: [],
}

const createAgreementComparison = (
  overrides: Partial<ComparisonProjectStatsComparison> = {},
): ComparisonProjectStatsComparison => {
  return {
    cohensKappa: 0.7,
    columnInfo: 'Title + abstract',
    conflictCount: 2,
    id: 'agreement-comparison',
    kind: 'human-vs-llm',
    label: 'GPT-5.5 (thinking: xhigh) vs Human',
    leftColumnId: 'human-column',
    overlapCount: 9,
    rightColumnId: 'llm-column',
    sensitivity: 0.8,
    specificity: 0.6,
    trueConflictCount: 1,
    ...overrides,
  }
}

const createCategoryBreakdown = (
  params: Pick<ComparisonProjectStatsCategoryBreakdown, 'articleCount' | 'category' | 'label'> & {
    additionalProjectStats?: ComparisonProjectAdditionalStats
    comparisons?: ComparisonProjectStatsComparison[]
  },
): ComparisonProjectStatsCategoryBreakdown => {
  return {
    additionalProjectStats: params.additionalProjectStats ?? emptyAdditionalStats,
    articleCount: params.articleCount,
    category: params.category,
    comparisons: params.comparisons ?? [],
    label: params.label,
  }
}

const createStats = (
  categoryBreakdowns: ComparisonProjectStatsCategoryBreakdown[],
  comparisons: ComparisonProjectStatsComparison[] = [],
): ComparisonProjectStats => {
  return {
    activeGeneration: 1,
    additionalProjectStats: emptyAdditionalStats,
    categoryBreakdowns,
    comparisons,
    isServingReady: true,
    servingStatus: 'ready',
    servingUpdatedAt: null,
  }
}

const renderSection = (stats: ComparisonProjectStats) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ComparisonProjectChineseStatsSection stats={stats} />
  }, container)

  return {container, dispose}
}

describe('ComparisonProjectChineseStatsSection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('hides the section when no Chinese articles exist', () => {
    const stats = createStats([
      createCategoryBreakdown({articleCount: 0, category: 'chinese', label: 'Chinese'}),
      createCategoryBreakdown({articleCount: 4, category: 'non_chinese', label: 'Non-Chinese'}),
    ])
    const {container, dispose} = renderSection(stats)

    try {
      expect(container.textContent).not.toContain('Chinese vs Non-Chinese')
    } finally {
      dispose()
    }
  })

  test('renders project stats comparison rows split by category', () => {
    const conflictResolutionLabel =
      'GPT-5.5 (thinking: xhigh) vs Conflict resolution (fallback to human answer if no resolution provided)'
    const humanComparison = createAgreementComparison({overlapCount: 14})
    const conflictResolutionComparison = createAgreementComparison({
      id: 'conflict-resolution-comparison',
      kind: 'llm-vs-conflict-resolution',
      label: conflictResolutionLabel,
      overlapCount: 12,
    })
    const stats = createStats(
      [
        createCategoryBreakdown({
          articleCount: 3,
          category: 'chinese',
          comparisons: [
            createAgreementComparison({overlapCount: 4}),
            createAgreementComparison({
              id: 'conflict-resolution-comparison',
              kind: 'llm-vs-conflict-resolution',
              label: conflictResolutionLabel,
              overlapCount: 3,
            }),
          ],
          label: 'Chinese',
        }),
        createCategoryBreakdown({
          articleCount: 5,
          category: 'non_chinese',
          comparisons: [
            createAgreementComparison({overlapCount: 10}),
            createAgreementComparison({
              id: 'conflict-resolution-comparison',
              kind: 'llm-vs-conflict-resolution',
              label: conflictResolutionLabel,
              overlapCount: 9,
            }),
          ],
          label: 'Non-Chinese',
        }),
      ],
      [humanComparison, conflictResolutionComparison],
    )
    const {container, dispose} = renderSection(stats)

    try {
      const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) => {
        return row.textContent ?? ''
      })

      expect(container.textContent).toContain('Chinese vs Non-Chinese')
      expect(container.textContent).toContain('Same comparison pairs as Project Stats')
      expect(container.textContent).toContain('Chinese, Non-Chinese, and Total rows')
      expect(container.textContent).toContain('Counts use each row')
      expect(container.textContent).toContain('GPT-5.5 (thinking: xhigh) vs Human')
      expect(container.textContent).toContain(conflictResolutionLabel)
      expect(container.querySelectorAll('table')).toHaveLength(1)
      expect(rows).toHaveLength(6)
      expect(rows[0]).toContain('GPT-5.5 (thinking: xhigh) vs Human')
      expect(rows[0]).toContain('Chinese')
      expect(rows[0]).toContain('4')
      expect(rows[1]).toContain('GPT-5.5 (thinking: xhigh) vs Human')
      expect(rows[1]).toContain('Non-Chinese')
      expect(rows[1]).toContain('10')
      expect(rows[2]).toContain('GPT-5.5 (thinking: xhigh) vs Human')
      expect(rows[2]).toContain('Total')
      expect(rows[2]).toContain('14')
      expect(rows[3]).toContain(conflictResolutionLabel)
      expect(rows[3]).toContain('Chinese')
      expect(rows[4]).toContain(conflictResolutionLabel)
      expect(rows[4]).toContain('Non-Chinese')
      expect(rows[5]).toContain(conflictResolutionLabel)
      expect(container.textContent).toContain('Total')
      expect(container.textContent).toContain('Column Info')
      expect(container.textContent).toContain('Title + abstract')
      expect(container.textContent).toContain('Overlap')
      expect(container.textContent).not.toContain('Articles')
      expect(container.textContent).toContain('Conflicts')
      expect(container.textContent).toContain('True Conflicts')
      expect(container.textContent).toContain("Cohen's Kappa")
      expect(container.textContent).not.toContain('Accuracy')
    } finally {
      dispose()
    }
  })

  test('renders comparison metrics when no resolved truth exists', () => {
    const stats = createStats(
      [
        createCategoryBreakdown({
          articleCount: 3,
          category: 'chinese',
          comparisons: [createAgreementComparison()],
          label: 'Chinese',
        }),
        createCategoryBreakdown({
          articleCount: 5,
          category: 'non_chinese',
          comparisons: [createAgreementComparison()],
          label: 'Non-Chinese',
        }),
      ],
      [createAgreementComparison()],
    )
    const {container, dispose} = renderSection(stats)

    try {
      expect(container.textContent).toContain('GPT-5.5 (thinking: xhigh) vs Human')
      expect(container.textContent).toContain('Overlap')
      expect(container.textContent).not.toContain('Articles')
      expect(container.textContent).toContain('Conflicts')
      expect(container.textContent).toContain('True Conflicts')
      expect(container.textContent).toContain("Cohen's Kappa")
      expect(container.textContent).toContain('Sensitivity')
      expect(container.textContent).toContain('Specificity')
      expect(container.textContent).not.toContain('Accuracy')
    } finally {
      dispose()
    }
  })
})

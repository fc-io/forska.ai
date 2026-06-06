// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, describe, expect, test} from 'vitest'

import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStats,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsComparison,
  ComparisonProjectStatsResolvedTruthComparison,
  ComparisonProjectStatsTruthConfusionMetrics,
} from '../../../../../../services/comparisonProjectsService.ts'
import {ComparisonProjectChineseStatsSection} from './comparisonProjectChineseStatsSection.tsx'

const emptyAdditionalStats: ComparisonProjectAdditionalStats = {
  conflictResolutionAnswerComparisons: [],
  resolvedTruthComparisons: [],
}

const createMetrics = (
  overrides: Partial<ComparisonProjectStatsTruthConfusionMetrics> = {},
): ComparisonProjectStatsTruthConfusionMetrics => {
  return {
    accuracy: 0.75,
    balancedAccuracy: 0.7,
    f1: 0.8,
    falseNegativeCount: 1,
    falsePositiveCount: 2,
    negativePredictiveValue: 0.6,
    precision: 0.8,
    sensitivity: 0.9,
    specificity: 0.5,
    trueCorrectCount: 6,
    trueErrorCount: 2,
    trueNegativeCount: 3,
    truePositiveCount: 4,
    truthPrevalence: 0.625,
    ...overrides,
  }
}

const createAgreementComparison = (
  overrides: Partial<ComparisonProjectStatsComparison> = {},
): ComparisonProjectStatsComparison => {
  return {
    cohensKappa: 0.7,
    columnInfo: null,
    conflictCount: 2,
    id: 'agreement-comparison',
    kind: 'human-vs-llm',
    label: 'Agreement row',
    leftColumnId: 'human-column',
    overlapCount: 9,
    rightColumnId: 'llm-column',
    sensitivity: 0.8,
    specificity: 0.6,
    trueConflictCount: 1,
    ...overrides,
  }
}

const createResolvedTruthComparison = (
  overrides: Partial<ComparisonProjectStatsResolvedTruthComparison> = {},
): ComparisonProjectStatsResolvedTruthComparison => {
  return {
    bothCorrectCount: 3,
    bothWrongCount: 1,
    columnInfo: null,
    humanColumnId: 'human-column',
    humanCorrectVsTruthCount: 6,
    humanErrorsVsTruthCount: 2,
    humanMetrics: createMetrics(),
    humanOnlyCorrectCount: 1,
    id: 'resolved-truth-comparison',
    label: 'Truth model',
    llmAdvantage: 0,
    llmColumnId: 'llm-column',
    llmCorrectVsTruthCount: 6,
    llmErrorsVsTruthCount: 2,
    llmMetrics: createMetrics({accuracy: 0.875}),
    llmOnlyCorrectCount: 1,
    mcnemarChiSquare: null,
    resolvedCount: 8,
    winner: 'Tie',
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

const createStats = (categoryBreakdowns: ComparisonProjectStatsCategoryBreakdown[]): ComparisonProjectStats => {
  return {
    activeGeneration: 1,
    additionalProjectStats: emptyAdditionalStats,
    categoryBreakdowns,
    comparisons: [],
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

  test('renders resolved truth metrics before agreement metrics', () => {
    const stats = createStats([
      createCategoryBreakdown({
        additionalProjectStats: {...emptyAdditionalStats, resolvedTruthComparisons: [createResolvedTruthComparison()]},
        articleCount: 3,
        category: 'chinese',
        comparisons: [createAgreementComparison()],
        label: 'Chinese',
      }),
      createCategoryBreakdown({
        additionalProjectStats: {
          ...emptyAdditionalStats,
          resolvedTruthComparisons: [createResolvedTruthComparison({id: 'non-chinese-truth'})],
        },
        articleCount: 5,
        category: 'non_chinese',
        label: 'Non-Chinese',
      }),
    ])
    const {container, dispose} = renderSection(stats)

    try {
      expect(container.textContent).toContain('Chinese vs Non-Chinese')
      expect(container.textContent).toContain('Resolved')
      expect(container.textContent).toContain('Accuracy')
      expect(container.textContent).toContain('Balanced accuracy')
      expect(container.textContent).toContain('Truth prevalence')
      expect(container.textContent).toContain('TP')
      expect(container.textContent).toContain('FP')
      expect(container.textContent).toContain('TN')
      expect(container.textContent).toContain('FN')
      expect(container.textContent).not.toContain('Agreement row')
      expect(container.textContent).not.toContain("Cohen's Kappa")
    } finally {
      dispose()
    }
  })

  test('renders agreement metrics when no resolved truth exists', () => {
    const stats = createStats([
      createCategoryBreakdown({
        articleCount: 3,
        category: 'chinese',
        comparisons: [createAgreementComparison()],
        label: 'Chinese',
      }),
      createCategoryBreakdown({
        articleCount: 5,
        category: 'non_chinese',
        comparisons: [createAgreementComparison({id: 'non-chinese-agreement'})],
        label: 'Non-Chinese',
      }),
    ])
    const {container, dispose} = renderSection(stats)

    try {
      expect(container.textContent).toContain('Agreement row')
      expect(container.textContent).toContain('Overlap')
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

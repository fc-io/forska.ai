import {describe, expect, test} from 'vitest'

import type {ComparisonProjectServingProgress} from '../../../../../services/comparisonProjectsService.ts'
import {getComparisonAnswerProgressLabel} from './comparisonProjectServingProgress.tsx'

const getProgress = (overrides: Partial<ComparisonProjectServingProgress>): ComparisonProjectServingProgress => {
  return {
    completedAt: null,
    failedAt: null,
    generation: 1,
    lastError: null,
    lastProgressedAt: null,
    phase: 'prompt_cells',
    phaseStartedAt: null,
    stagedArticleCount: 0,
    stagedCellCount: 0,
    stagedFilterMemberCount: 0,
    stagedFilterStatsCount: 0,
    startedAt: null,
    totalArticleCount: null,
    totalCellCount: null,
    ...overrides,
  }
}

describe('getComparisonAnswerProgressLabel', () => {
  test('explains staged comparison answers as an average across known articles', () => {
    expect(
      getComparisonAnswerProgressLabel(
        getProgress({stagedArticleCount: 0, stagedCellCount: 181_463, totalArticleCount: 18_784, totalCellCount: null}),
      ),
    ).toBe(
      '181,463 comparison answers across 18,784 articles (~9.7 per article; total known after answer materialization)',
    )
  })

  test('includes the final answer total once materialization has completed', () => {
    expect(
      getComparisonAnswerProgressLabel(
        getProgress({
          stagedArticleCount: 18_784,
          stagedCellCount: 224_604,
          totalArticleCount: 18_784,
          totalCellCount: 224_604,
        }),
      ),
    ).toBe('224,604 comparison answers across 18,784 articles (~12.0 per article; 224,604 total)')
  })
})

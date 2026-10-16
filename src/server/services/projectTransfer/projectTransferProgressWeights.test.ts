import {expect, test} from 'bun:test'

import {
  getProjectTransferCommitWriterFraction,
  getProjectTransferCompletedOverallProgress,
  getProjectTransferOverallProgress,
  getProjectTransferRevalidationFraction,
  getProjectTransferTargetAnalysisFraction,
  projectTransferOverallProgressSteps,
  projectTransferRevalidationPartShares,
  projectTransferTargetAnalysisStepShares,
} from './projectTransferProgressWeights.ts'

const sum = (values: readonly number[]) => {
  return values.reduce((total, value) => {
    return total + value
  }, 0)
}

test('overall progress weights sum to 100 per operation and step shares sum to 1', () => {
  expect(
    sum(
      projectTransferOverallProgressSteps.analyze.map((step) => {
        return step.weight
      }),
    ),
  ).toBe(100)
  expect(
    sum(
      projectTransferOverallProgressSteps.commit.map((step) => {
        return step.weight
      }),
    ),
  ).toBe(100)
  expect(
    sum(
      projectTransferTargetAnalysisStepShares.map((step) => {
        return step.share
      }),
    ),
  ).toBeCloseTo(1, 10)
  expect(
    sum(
      projectTransferRevalidationPartShares.map((part) => {
        return part.share
      }),
    ),
  ).toBeCloseTo(1, 10)
  expect(
    projectTransferOverallProgressSteps.commit.map((step) => {
      return step.key
    }),
  ).toEqual(['waitForDuckdb', 'revalidation', 'loadPayloads', 'prepare', 'writeTables', 'finish'])
})

test('overall percent is completed step weight plus the current step share', () => {
  expect(getProjectTransferOverallProgress({operation: 'analyze', step: 'zipScan', stepFraction: 0})).toEqual({
    operation: 'analyze',
    percent: 3,
    step: {count: 6, endPercent: 18, index: 2, key: 'zipScan', label: 'Scanning package archive', startPercent: 3},
    stepFraction: 0,
  })
  expect(
    getProjectTransferOverallProgress({operation: 'analyze', step: 'targetAnalysis', stepFraction: 0.5}).percent,
  ).toBe(67)
  expect(getProjectTransferOverallProgress({operation: 'commit', step: 'revalidation', stepFraction: 1}).percent).toBe(
    34,
  )
  expect(getProjectTransferOverallProgress({operation: 'commit', step: 'writeTables', stepFraction: 2}).percent).toBe(
    97,
  )
  expect(getProjectTransferOverallProgress({operation: 'commit', step: 'loadPayloads', stepFraction: -1}).percent).toBe(
    34,
  )
})

test('a waiting step reports a null fraction at its start percent and never undercuts the previous percent', () => {
  const waiting = getProjectTransferOverallProgress({operation: 'commit', step: 'waitForDuckdb', stepFraction: null})
  const afterRevalidation = getProjectTransferOverallProgress({
    operation: 'commit',
    previousPercent: 34,
    step: 'waitForDuckdb',
    stepFraction: null,
  })

  expect(waiting).toMatchObject({percent: 0, step: {endPercent: 2, index: 1, startPercent: 0}, stepFraction: null})
  expect(afterRevalidation.percent).toBe(34)
})

test('completed operations end at 100', () => {
  expect(getProjectTransferCompletedOverallProgress('analyze')).toMatchObject({
    percent: 100,
    step: {index: 6, key: 'finalize'},
    stepFraction: 1,
  })
  expect(getProjectTransferCompletedOverallProgress('commit')).toMatchObject({
    percent: 100,
    step: {index: 6, key: 'finish'},
    stepFraction: 1,
  })
})

test('target analysis, revalidation, and writer fractions grow with their sub-steps', () => {
  const targetFractions = projectTransferTargetAnalysisStepShares.map((share) => {
    return getProjectTransferTargetAnalysisFraction({step: share.key, stepFraction: 0})
  })
  const writerFractions = [1, 2, 3, 4, 5, 6, 7].map((index) => {
    const completedRows = [0, 100, 120, 125, 145, 195, 200][index - 1] ?? 0

    return getProjectTransferCommitWriterFraction({
      completedRows,
      count: 7,
      index,
      key: `step-${index}`,
      label: `step ${index}`,
      rows: 0,
      totalRows: 200,
    })
  })

  expect(targetFractions[0]).toBe(0)
  expect(targetFractions[1]).toBeCloseTo(0.15, 10)
  expect(getProjectTransferTargetAnalysisFraction({step: 'fidelity', stepFraction: 1})).toBe(1)
  expect(
    targetFractions.every((fraction, index) => {
      return index === 0 || fraction > (targetFractions[index - 1] ?? 0)
    }),
  ).toBe(true)
  expect(getProjectTransferRevalidationFraction({message: 'x', part: 'targetAnalysis', partFraction: 0.5})).toBeCloseTo(
    0.375,
    10,
  )
  expect(getProjectTransferRevalidationFraction({message: 'x', part: 'dependencies', partFraction: 1})).toBe(1)
  expect(writerFractions[0]).toBe(0)
  expect(
    writerFractions.every((fraction, index) => {
      return fraction <= 1 && (index === 0 || fraction > (writerFractions[index - 1] ?? 0))
    }),
  ).toBe(true)
  expect(
    getProjectTransferCommitWriterFraction({
      completedRows: 0,
      count: 4,
      index: 3,
      key: 'empty',
      label: 'empty',
      rows: 0,
      totalRows: 0,
    }),
  ).toBe(0.5)
})

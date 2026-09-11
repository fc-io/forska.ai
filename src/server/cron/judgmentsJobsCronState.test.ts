import {expect, test} from 'bun:test'

import {
  beginJudgmentsCleanupStaleCronRun,
  beginJudgmentsImportCronRun,
  finishJudgmentsCleanupStaleCronRun,
  finishJudgmentsImportCronRun,
  getJudgmentsCleanupStaleCronActivity,
  getJudgmentsImportCronActivity,
  JUDGMENTS_CLEANUP_STALE_MARKER_STALE_AFTER_MS,
  JUDGMENTS_IMPORT_STALE_AFTER_MS,
  markJudgmentsCleanupStaleCronPartial,
  updateJudgmentsCleanupStaleCronStep,
} from './judgmentsJobsCronState.ts'

test('judgments import cron latch is stale-aware and run-token guarded', () => {
  const firstRunId = beginJudgmentsImportCronRun(1_000)

  expect(getJudgmentsImportCronActivity(1_000 + JUDGMENTS_IMPORT_STALE_AFTER_MS - 1)).toMatchObject({
    isImportingJudgments: true,
    runId: firstRunId,
    shouldBlockOtherJudgmentWork: true,
    stale: false,
  })

  expect(getJudgmentsImportCronActivity(1_000 + JUDGMENTS_IMPORT_STALE_AFTER_MS)).toMatchObject({
    isImportingJudgments: true,
    runId: firstRunId,
    runningForMs: JUDGMENTS_IMPORT_STALE_AFTER_MS,
    shouldBlockOtherJudgmentWork: false,
    stale: true,
  })

  const secondRunId = beginJudgmentsImportCronRun(1_000 + JUDGMENTS_IMPORT_STALE_AFTER_MS + 1)

  expect(finishJudgmentsImportCronRun(firstRunId)).toBe(false)
  expect(getJudgmentsImportCronActivity(1_000 + JUDGMENTS_IMPORT_STALE_AFTER_MS + 2)).toMatchObject({
    isImportingJudgments: true,
    runId: secondRunId,
    shouldBlockOtherJudgmentWork: true,
    stale: false,
  })

  expect(finishJudgmentsImportCronRun(secondRunId)).toBe(true)
  expect(getJudgmentsImportCronActivity()).toMatchObject({
    isImportingJudgments: false,
    runId: null,
    shouldBlockOtherJudgmentWork: false,
    stale: false,
  })
})

test('cleanup-stale cron activity tracks current step and over-budget state without blocking other work', () => {
  const runId = beginJudgmentsCleanupStaleCronRun({budgetMs: 500, nowMs: 10_000})

  expect(runId).toBeTruthy()
  if (!runId) {
    throw new Error('Expected cleanup run id')
  }

  expect(updateJudgmentsCleanupStaleCronStep({nowMs: 10_050, runId, step: 'prune-retention'})).toBe(true)
  expect(getJudgmentsCleanupStaleCronActivity(10_499)).toMatchObject({
    budgetMs: 500,
    currentStep: 'prune-retention',
    isCleanupStaleRunning: true,
    overBudget: false,
    runningForMs: 499,
    shouldStartAnotherCleanupRun: false,
    stale: false,
  })
  expect(beginJudgmentsCleanupStaleCronRun({budgetMs: 500, nowMs: 10_100})).toBe(null)

  expect(getJudgmentsCleanupStaleCronActivity(10_500)).toMatchObject({
    overBudget: true,
    shouldStartAnotherCleanupRun: false,
    stale: false,
  })
  expect(getJudgmentsCleanupStaleCronActivity(10_000 + JUDGMENTS_CLEANUP_STALE_MARKER_STALE_AFTER_MS)).toMatchObject({
    overBudget: true,
    shouldStartAnotherCleanupRun: false,
    stale: true,
  })

  expect(markJudgmentsCleanupStaleCronPartial({exhaustedBudget: true, reason: 'row-budget', runId})).toBe(true)
  expect(finishJudgmentsCleanupStaleCronRun({exhaustedBudget: true, partialReason: 'row-budget', runId})).toBe(true)
  expect(getJudgmentsCleanupStaleCronActivity(11_000)).toMatchObject({
    exhaustedBudget: true,
    isCleanupStaleRunning: false,
    lastPartial: true,
    lastPartialReason: 'row-budget',
    shouldStartAnotherCleanupRun: true,
  })
})

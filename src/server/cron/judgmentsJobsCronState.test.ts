import {expect, test} from 'bun:test'

import {
  JUDGMENTS_IMPORT_STALE_AFTER_MS,
  beginJudgmentsImportCronRun,
  finishJudgmentsImportCronRun,
  getJudgmentsImportCronActivity,
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

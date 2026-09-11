export const JUDGMENTS_IMPORT_STALE_AFTER_MS = 120_000

export type JudgmentsImportCronActivity = {
  isImportingJudgments: boolean
  runId: string | null
  runningForMs: number | null
  shouldBlockOtherJudgmentWork: boolean
  startedAtMs: number | null
  stale: boolean
}

let nextImportRunSequence = 0

export const judgmentsJobsCronState = {
  importingJudgmentsRunId: null as string | null,
  importingJudgmentsStartedAtMs: null as number | null,
  isImportingJudgments: false,
}

export const beginJudgmentsImportCronRun = (nowMs = Date.now()): string => {
  nextImportRunSequence += 1
  const runId = `${nowMs}:${nextImportRunSequence}`

  judgmentsJobsCronState.importingJudgmentsRunId = runId
  judgmentsJobsCronState.importingJudgmentsStartedAtMs = nowMs
  judgmentsJobsCronState.isImportingJudgments = true

  return runId
}

export const finishJudgmentsImportCronRun = (runId: string): boolean => {
  if (judgmentsJobsCronState.importingJudgmentsRunId !== runId) {
    return false
  }

  judgmentsJobsCronState.importingJudgmentsRunId = null
  judgmentsJobsCronState.importingJudgmentsStartedAtMs = null
  judgmentsJobsCronState.isImportingJudgments = false

  return true
}

export const getJudgmentsImportCronActivity = (nowMs = Date.now()): JudgmentsImportCronActivity => {
  const startedAtMs = judgmentsJobsCronState.importingJudgmentsStartedAtMs
  const runningForMs = startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs)
  const stale = runningForMs !== null && runningForMs >= JUDGMENTS_IMPORT_STALE_AFTER_MS

  return {
    isImportingJudgments: judgmentsJobsCronState.isImportingJudgments,
    runId: judgmentsJobsCronState.importingJudgmentsRunId,
    runningForMs,
    shouldBlockOtherJudgmentWork: judgmentsJobsCronState.isImportingJudgments && !stale,
    startedAtMs,
    stale: judgmentsJobsCronState.isImportingJudgments && stale,
  }
}

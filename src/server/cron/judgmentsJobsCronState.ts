export const JUDGMENTS_IMPORT_STALE_AFTER_MS = 120_000
export const JUDGMENTS_CLEANUP_STALE_DEFAULT_BUDGET_MS = 3_000
export const JUDGMENTS_CLEANUP_STALE_MARKER_STALE_AFTER_MS = 60_000

export type JudgmentsImportCronActivity = {
  isImportingJudgments: boolean
  runId: string | null
  runningForMs: number | null
  shouldBlockOtherJudgmentWork: boolean
  startedAtMs: number | null
  stale: boolean
}

export type JudgmentsCleanupStaleCronActivity = {
  budgetMs: number | null
  currentStep: string | null
  currentStepStartedAtMs: number | null
  exhaustedBudget: boolean
  isCleanupStaleRunning: boolean
  lastCompletedAtMs: number | null
  lastErrorMessage: string | null
  lastFinishedAtMs: number | null
  lastPartial: boolean
  lastPartialReason: string | null
  overBudget: boolean
  runId: string | null
  runningForMs: number | null
  shouldStartAnotherCleanupRun: boolean
  startedAtMs: number | null
  stale: boolean
}

let nextImportRunSequence = 0
let nextCleanupStaleRunSequence = 0

export const judgmentsJobsCronState = {
  cleanupStaleBudgetMs: null as number | null,
  cleanupStaleCurrentStep: null as string | null,
  cleanupStaleCurrentStepStartedAtMs: null as number | null,
  cleanupStaleExhaustedBudget: false,
  cleanupStaleLastCompletedAtMs: null as number | null,
  cleanupStaleLastErrorMessage: null as string | null,
  cleanupStaleLastFinishedAtMs: null as number | null,
  cleanupStaleLastPartial: false,
  cleanupStaleLastPartialReason: null as string | null,
  cleanupStaleRunId: null as string | null,
  cleanupStaleStartedAtMs: null as number | null,
  isCleaningUpStaleJudgments: false,
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

const getCleanupStaleRunId = (nowMs: number) => {
  nextCleanupStaleRunSequence += 1
  return `${nowMs}:${nextCleanupStaleRunSequence}`
}

const getCleanupStaleErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export const beginJudgmentsCleanupStaleCronRun = ({
  budgetMs = JUDGMENTS_CLEANUP_STALE_DEFAULT_BUDGET_MS,
  nowMs = Date.now(),
}: {budgetMs?: number; nowMs?: number} = {}): string | null => {
  if (judgmentsJobsCronState.isCleaningUpStaleJudgments) {
    return null
  }

  const runId = getCleanupStaleRunId(nowMs)

  judgmentsJobsCronState.cleanupStaleBudgetMs = budgetMs
  judgmentsJobsCronState.cleanupStaleCurrentStep = null
  judgmentsJobsCronState.cleanupStaleCurrentStepStartedAtMs = null
  judgmentsJobsCronState.cleanupStaleExhaustedBudget = false
  judgmentsJobsCronState.cleanupStaleLastErrorMessage = null
  judgmentsJobsCronState.cleanupStaleLastPartial = false
  judgmentsJobsCronState.cleanupStaleLastPartialReason = null
  judgmentsJobsCronState.cleanupStaleRunId = runId
  judgmentsJobsCronState.cleanupStaleStartedAtMs = nowMs
  judgmentsJobsCronState.isCleaningUpStaleJudgments = true

  return runId
}

export const updateJudgmentsCleanupStaleCronStep = ({
  nowMs = Date.now(),
  runId,
  step,
}: {
  nowMs?: number
  runId: string
  step: string | null
}): boolean => {
  if (judgmentsJobsCronState.cleanupStaleRunId !== runId) {
    return false
  }

  judgmentsJobsCronState.cleanupStaleCurrentStep = step
  judgmentsJobsCronState.cleanupStaleCurrentStepStartedAtMs = step === null ? null : nowMs

  return true
}

export const markJudgmentsCleanupStaleCronPartial = ({
  exhaustedBudget,
  reason,
  runId,
}: {
  exhaustedBudget: boolean
  reason: string
  runId: string
}): boolean => {
  if (judgmentsJobsCronState.cleanupStaleRunId !== runId) {
    return false
  }

  judgmentsJobsCronState.cleanupStaleExhaustedBudget =
    judgmentsJobsCronState.cleanupStaleExhaustedBudget || exhaustedBudget
  judgmentsJobsCronState.cleanupStaleLastPartial = true
  judgmentsJobsCronState.cleanupStaleLastPartialReason = reason

  return true
}

export const finishJudgmentsCleanupStaleCronRun = ({
  exhaustedBudget,
  partialReason,
  runId,
}: {
  exhaustedBudget: boolean
  partialReason: string | null
  runId: string
}): boolean => {
  if (judgmentsJobsCronState.cleanupStaleRunId !== runId) {
    return false
  }

  const finishedAtMs = Date.now()

  judgmentsJobsCronState.cleanupStaleCurrentStep = null
  judgmentsJobsCronState.cleanupStaleCurrentStepStartedAtMs = null
  judgmentsJobsCronState.cleanupStaleExhaustedBudget = exhaustedBudget
  judgmentsJobsCronState.cleanupStaleLastCompletedAtMs = finishedAtMs
  judgmentsJobsCronState.cleanupStaleLastErrorMessage = null
  judgmentsJobsCronState.cleanupStaleLastFinishedAtMs = finishedAtMs
  judgmentsJobsCronState.cleanupStaleLastPartial = exhaustedBudget || partialReason !== null
  judgmentsJobsCronState.cleanupStaleLastPartialReason = partialReason
  judgmentsJobsCronState.cleanupStaleRunId = null
  judgmentsJobsCronState.cleanupStaleStartedAtMs = null
  judgmentsJobsCronState.isCleaningUpStaleJudgments = false

  return true
}

export const failJudgmentsCleanupStaleCronRun = ({error, runId}: {error: unknown; runId: string}): boolean => {
  if (judgmentsJobsCronState.cleanupStaleRunId !== runId) {
    return false
  }

  judgmentsJobsCronState.cleanupStaleCurrentStep = null
  judgmentsJobsCronState.cleanupStaleCurrentStepStartedAtMs = null
  judgmentsJobsCronState.cleanupStaleLastErrorMessage = getCleanupStaleErrorMessage(error)
  judgmentsJobsCronState.cleanupStaleLastFinishedAtMs = Date.now()
  judgmentsJobsCronState.cleanupStaleRunId = null
  judgmentsJobsCronState.cleanupStaleStartedAtMs = null
  judgmentsJobsCronState.isCleaningUpStaleJudgments = false

  return true
}

export const getJudgmentsCleanupStaleCronActivity = (nowMs = Date.now()): JudgmentsCleanupStaleCronActivity => {
  const startedAtMs = judgmentsJobsCronState.cleanupStaleStartedAtMs
  const runningForMs = startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs)
  const budgetMs = judgmentsJobsCronState.cleanupStaleBudgetMs
  const overBudget = runningForMs !== null && budgetMs !== null && runningForMs >= budgetMs
  const stale =
    runningForMs !== null && runningForMs >= Math.max(JUDGMENTS_CLEANUP_STALE_MARKER_STALE_AFTER_MS, budgetMs ?? 0)

  return {
    budgetMs,
    currentStep: judgmentsJobsCronState.cleanupStaleCurrentStep,
    currentStepStartedAtMs: judgmentsJobsCronState.cleanupStaleCurrentStepStartedAtMs,
    exhaustedBudget: judgmentsJobsCronState.cleanupStaleExhaustedBudget,
    isCleanupStaleRunning: judgmentsJobsCronState.isCleaningUpStaleJudgments,
    lastCompletedAtMs: judgmentsJobsCronState.cleanupStaleLastCompletedAtMs,
    lastErrorMessage: judgmentsJobsCronState.cleanupStaleLastErrorMessage,
    lastFinishedAtMs: judgmentsJobsCronState.cleanupStaleLastFinishedAtMs,
    lastPartial: judgmentsJobsCronState.cleanupStaleLastPartial,
    lastPartialReason: judgmentsJobsCronState.cleanupStaleLastPartialReason,
    overBudget: judgmentsJobsCronState.isCleaningUpStaleJudgments && overBudget,
    runId: judgmentsJobsCronState.cleanupStaleRunId,
    runningForMs,
    shouldStartAnotherCleanupRun: !judgmentsJobsCronState.isCleaningUpStaleJudgments,
    startedAtMs,
    stale: judgmentsJobsCronState.isCleaningUpStaleJudgments && stale,
  }
}

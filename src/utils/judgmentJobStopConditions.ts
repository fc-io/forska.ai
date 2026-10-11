export const judgmentJobStopReasons = ['deadline', 'token_budget', 'article_cap', 'human_answered_done'] as const

export type JudgmentJobStopReason = (typeof judgmentJobStopReasons)[number]

export type JudgmentJobStopConditions = {
  stopAfterArticles: number | null
  stopAfterTotalTokens: number | null
  stopAt: Date | null
  stopWhenHumanAnsweredDone: boolean
}

export type JudgmentJobStopProgress = {admittedArticleCount: number | null; totalTokens: number | null}

export const maxJudgmentJobStopAfterArticles = 2_147_483_647

export const maxJudgmentJobStopAfterTotalTokens = Number.MAX_SAFE_INTEGER

const stopConditionLabels: Record<JudgmentJobStopReason, string> = {
  article_cap: 'article cap',
  deadline: 'deadline',
  human_answered_done: 'human-answered',
  token_budget: 'token budget',
}

const getPositiveIntegerOrNull = (value: unknown): number | null => {
  const numberValue =
    typeof value === 'bigint' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : value

  return typeof numberValue === 'number' && Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null
}

const getDateOrNull = (value: unknown): Date | null => {
  const date = value instanceof Date ? value : typeof value === 'string' && value !== '' ? new Date(value) : null

  return date && Number.isFinite(date.getTime()) ? date : null
}

export const isJudgmentJobStopReason = (value: unknown): value is JudgmentJobStopReason => {
  return typeof value === 'string' && (judgmentJobStopReasons as readonly string[]).includes(value)
}

export const getJudgmentJobStopConditions = (row: {
  stopAfterArticles?: unknown
  stopAfterTotalTokens?: unknown
  stopAt?: unknown
  stopWhenHumanAnsweredDone?: unknown
}): JudgmentJobStopConditions => {
  return {
    stopAfterArticles: getPositiveIntegerOrNull(row.stopAfterArticles),
    stopAfterTotalTokens: getPositiveIntegerOrNull(row.stopAfterTotalTokens),
    stopAt: getDateOrNull(row.stopAt),
    stopWhenHumanAnsweredDone: row.stopWhenHumanAnsweredDone === true,
  }
}

export const hasJudgmentJobStopCondition = (conditions: JudgmentJobStopConditions): boolean => {
  return (
    conditions.stopAfterArticles !== null
    || conditions.stopAfterTotalTokens !== null
    || conditions.stopAt !== null
    || conditions.stopWhenHumanAnsweredDone
  )
}

export const isJudgmentJobDeadlineReached = (stopAt: Date | null, now: Date): boolean => {
  return stopAt !== null && now.getTime() >= stopAt.getTime()
}

export const isJudgmentJobTokenBudgetReached = (budget: number | null, totalTokens: number | null): boolean => {
  return budget !== null && totalTokens !== null && totalTokens >= budget
}

export const isJudgmentJobArticleCapReached = (cap: number | null, admittedArticleCount: number | null): boolean => {
  return cap !== null && admittedArticleCount !== null && admittedArticleCount >= cap
}

export const getJudgmentJobResumeBlockingStopReason = ({
  conditions,
  now,
  progress,
}: {
  conditions: JudgmentJobStopConditions
  now: Date
  progress: JudgmentJobStopProgress
}): JudgmentJobStopReason | null => {
  const blockingReasons: Array<[JudgmentJobStopReason, boolean]> = [
    ['deadline', isJudgmentJobDeadlineReached(conditions.stopAt, now)],
    ['token_budget', isJudgmentJobTokenBudgetReached(conditions.stopAfterTotalTokens, progress.totalTokens)],
    ['article_cap', isJudgmentJobArticleCapReached(conditions.stopAfterArticles, progress.admittedArticleCount)],
  ]
  const [blockingReason] = blockingReasons.find(([, isReached]) => {
    return isReached
  }) ?? [null]

  return blockingReason
}

export const getJudgmentJobStopConditionLabel = (reason: JudgmentJobStopReason): string => {
  return stopConditionLabels[reason]
}

export const getJudgmentJobResumeBlockedMessage = (reason: JudgmentJobStopReason): string => {
  return `Raise or clear the ${getJudgmentJobStopConditionLabel(reason)} stop condition to resume`
}

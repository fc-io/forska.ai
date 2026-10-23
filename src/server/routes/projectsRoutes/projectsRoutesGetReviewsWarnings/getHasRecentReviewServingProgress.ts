const recentReviewServingProgressWindowMs = 120_000
const reviewServingProgressClockSkewToleranceMs = 10_000

export const getHasRecentReviewServingProgress = (value: string | null) => {
  const progressedAtMs = new Date(value ?? Number.NaN).getTime()
  const progressAgeMs = Date.now() - progressedAtMs

  return (
    Number.isFinite(progressedAtMs)
    && progressAgeMs >= -reviewServingProgressClockSkewToleranceMs
    && progressAgeMs <= recentReviewServingProgressWindowMs
  )
}

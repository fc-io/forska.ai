import type {ReviewJudgment} from './articleReviewDetailTypes.ts'

export const getProviderRefusalSummary = ({
  enabledPromptCount,
  judgments,
}: {
  enabledPromptCount: number
  judgments: ReviewJudgment[]
}) => {
  const refusedPromptIds = new Set(
    judgments.flatMap((judgment) => {
      return 'providerRefusal' in judgment && judgment.providerRefusal ? [judgment.promptId] : []
    }),
  )

  return {enabledPromptCount, refusedPromptCount: refusedPromptIds.size}
}

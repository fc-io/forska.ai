import {splitProps} from 'solid-js'

export type ReviewJudgmentProviderFailure = {
  attemptCount: number
  failureCode: string
  failureCount: number
  lastFailedAt: string
  modelName: string | null
  providerKind: string | null
  reason: string
}

export const ReviewJudgmentItemProviderFailure = (props: {failure: ReviewJudgmentProviderFailure}) => {
  const [local] = splitProps(props, ['failure'])

  return (
    <>
      <div class="flex items-start justify-between gap-2 text-xs">
        <div class="flex items-start gap-2 min-w-0 flex-1">
          <span class="font-medium w-[70px] text-right shrink-0">Answer:</span>
          <span class="text-rose-700 font-semibold min-w-0 flex-1 break-words">MODEL CALL FAILED</span>
        </div>
      </div>
      <p class="text-xs text-gray-600 mt-2 break-words">
        {`The model call failed after retries (${local.failure.failureCode}, ${local.failure.lastFailedAt}): `}
        {local.failure.reason}
        <span class="block mt-1">Resume the job to retry.</span>
      </p>
    </>
  )
}

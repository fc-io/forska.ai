import {splitProps} from 'solid-js'

export type ReviewJudgmentProviderRefusal = {
  failureCode: string
  modelName: string
  providerKind: string | null
  reason: string
  refusedAt: string
}

export const ReviewJudgmentItemProviderRefusal = (props: {refusal: ReviewJudgmentProviderRefusal}) => {
  const [local] = splitProps(props, ['refusal'])

  return (
    <>
      <div class="flex items-start justify-between gap-2 text-xs">
        <div class="flex items-start gap-2 min-w-0 flex-1">
          <span class="font-medium w-[70px] text-right shrink-0">Answer:</span>
          <span class="text-red-600 font-semibold min-w-0 flex-1 break-words">MODEL REFUSED TO ANSWER</span>
        </div>
      </div>
      <p class="text-xs text-gray-600 mt-2 break-words">
        {local.refusal.modelName} refused this prompt ({local.refusal.failureCode}, {local.refusal.refusedAt}):{' '}
        {local.refusal.reason}
      </p>
    </>
  )
}

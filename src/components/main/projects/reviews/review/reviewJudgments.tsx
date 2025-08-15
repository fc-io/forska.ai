import {For, Show} from 'solid-js'

import {ReviewJudgmentItem} from './reviewJudgmentItem.tsx'

type ReviewJudgmentsProps = {
  judgments?: Array<{
    prompt: {originalText: string}
    answeredOriginal?: string | null
    confidenceOriginal?: number | null
    explanation?: string | null
    quotes?: unknown
    assessments?: Array<{
      assessmentIsCorrect?: boolean | null
      assessmentComment?: string | null
    }>
  }>
}

export const ReviewJudgments = (props: ReviewJudgmentsProps) => {
  return (
    <div class="p-6 bg-white rounded-lg shadow">
      <h2 class="text-xl font-bold mb-4">Judgments</h2>
      <Show
        when={props.judgments && props.judgments.length > 0}
        fallback={<p class="text-gray-500">No judgments available</p>}
      >
        <div class="space-y-4">
          <For each={props.judgments}>
            {(judgment) => {
              return <ReviewJudgmentItem judgment={judgment} />
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}


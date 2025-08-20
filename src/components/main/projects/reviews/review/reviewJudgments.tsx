import {For, Show} from 'solid-js'

import {ReviewJudgmentItem} from './reviewJudgmentItem.tsx'

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type ReviewJudgmentsProps = {
  judgments?: Array<{
    id: string
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
  setArticleViewToShow: SetArticleViewToShow
}

export const ReviewJudgments = (props: ReviewJudgmentsProps) => {
  return (
    <div class="sticky top-6 bg-white rounded-lg shadow h-fit">
      <div class="p-4 border-b">
        <h2 class="text-lg font-bold">Judgments</h2>
      </div>
      <Show
        when={props.judgments && props.judgments.length > 0}
        fallback={<p class="text-gray-500 p-4">No judgments available</p>}
      >
        <div class="p-2">
          <For each={props.judgments}>
            {(judgment) => {
              return (
                <ReviewJudgmentItem
                  judgment={judgment}
                  setArticleViewToShow={props.setArticleViewToShow}
                />
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

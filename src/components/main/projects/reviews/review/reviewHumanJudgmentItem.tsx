import {Show} from 'solid-js'

type ReviewHumanJudgmentItemProps = {
  judgment: {
    id: string
    prompt: {originalText: string}
    answer: string | null
    comment: string | null
  }
}

export const ReviewHumanJudgmentItem = (props: ReviewHumanJudgmentItemProps) => {
  return (
    <div class="border-b last:border-b-0 p-3">
      <div class="mb-2">
        <p class="text-sm font-medium text-gray-900 line-clamp-2">{props.judgment.prompt.originalText}</p>
      </div>
      <div class="text-xs">
        <span class="font-medium">Answer:</span>
        <span class="ml-2 text-gray-800 break-words">{props.judgment.answer ?? '—'}</span>
      </div>
      <Show when={props.judgment.comment}>
        <p class="text-xs text-gray-600 mt-2">{props.judgment.comment}</p>
      </Show>
    </div>
  )
}


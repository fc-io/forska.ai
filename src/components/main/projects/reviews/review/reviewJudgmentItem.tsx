import {For, Show} from 'solid-js'

import {ReviewJudgmentAssessments} from './reviewJudgmentAssessments.tsx'

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type ReviewJudgmentItemProps = {
  judgment: {
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
  }
  setArticleViewToShow: SetArticleViewToShow
}

export const ReviewJudgmentItem = (props: ReviewJudgmentItemProps) => {
  return (
    <div
      class="border rounded-lg p-4"
      onPointerOver={() => {
        props.setArticleViewToShow(props.judgment.id)
      }}
      onPointerLeave={() => {
        props.setArticleViewToShow(undefined)
      }}
    >
      <div class="mb-2">
        <span class="font-semibold">Prompt: </span>
        <span class="text-gray-700">{props.judgment.prompt.originalText}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span class="font-semibold">Answer: </span>
          <span
            class={
              props.judgment.answeredOriginal === 'yes'
                ? 'text-green-600'
                : props.judgment.answeredOriginal === 'no'
                  ? 'text-red-600'
                  : 'text-yellow-600'
            }
          >
            {props.judgment.answeredOriginal}
          </span>
        </div>
        <Show when={props.judgment.confidenceOriginal}>
          <div>
            <span class="font-semibold">Confidence: </span>
            <span>{props.judgment.confidenceOriginal}%</span>
          </div>
        </Show>
      </div>
      <Show when={props.judgment.explanation}>
        <div class="mt-2">
          <span class="font-semibold text-sm">Explanation: </span>
          <p class="text-sm text-gray-600 mt-1">{props.judgment.explanation}</p>
        </div>
      </Show>
      <Show
        when={props.judgment.quotes && Array.isArray(props.judgment.quotes)}
      >
        <div class="mt-2">
          <span class="font-semibold text-sm">Quotes: </span>
          <For each={props.judgment.quotes as string[]}>
            {(quote) => {
              return <p class="text-sm text-gray-600 mt-1">"{quote}"</p>
            }}
          </For>
        </div>
      </Show>
      <Show
        when={
          props.judgment.assessments && props.judgment.assessments.length > 0
        }
      >
        <ReviewJudgmentAssessments assessments={props.judgment.assessments} />
      </Show>
    </div>
  )
}

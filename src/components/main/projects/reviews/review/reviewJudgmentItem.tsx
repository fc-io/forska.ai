import {For, Show} from 'solid-js'

import {ReviewJudgmentAssessments} from './reviewJudgmentAssessments.tsx'

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type ReviewJudgmentItemProps = {
  judgment: {
    id: string
    promptId?: string
    prompt: {originalText: string; id?: string; contentHash?: string | null}
    answeredOriginal?: string | null
    confidenceOriginal?: number | null
    explanation?: string | null
    quotes?: unknown
    assessments?: Array<{assessmentIsCorrect?: boolean | null; assessmentComment?: string | null}>
  }
  setArticleViewToShow: SetArticleViewToShow
}

export const ReviewJudgmentItem = (props: ReviewJudgmentItemProps) => {
  const promptId = () => {
    return props.judgment.prompt?.id || props.judgment.promptId || undefined
  }
  const promptHash = () => {
    return props.judgment.prompt?.contentHash || undefined
  }
  return (
    <div
      class="border-b last:border-b-0 p-3 hover:bg-gray-50 cursor-pointer transition-colors"
      onPointerOver={() => {
        props.setArticleViewToShow(props.judgment.id)
      }}
      onPointerLeave={() => {
        props.setArticleViewToShow(undefined)
      }}
    >
      <div class="mb-2">
        <p class="text-sm font-medium text-gray-900 line-clamp-2">{props.judgment.prompt.originalText}</p>
        <div class="mt-1 text-[11px] text-gray-500">
          <span>
            {promptId() ? `Prompt ID: ${String(promptId()).slice(0, 8)}` : ''}
            {promptId() && promptHash() ? ' • ' : ''}
            {promptHash() ? `Prompt Hash: ${String(promptHash()).slice(0, 8)}` : ''}
          </span>
        </div>
      </div>
      <div class="flex items-center justify-between text-xs">
        <div class="flex items-center gap-2">
          <span class="font-medium">Answer:</span>
          <span
            class={
              props.judgment.answeredOriginal === 'yes'
                ? 'text-green-600 font-semibold'
                : props.judgment.answeredOriginal === 'no'
                  ? 'text-red-600 font-semibold'
                  : 'text-yellow-600 font-semibold'
            }
          >
            {props.judgment.answeredOriginal?.toUpperCase()}
          </span>
        </div>
        <Show when={props.judgment.confidenceOriginal}>
          <div class="text-gray-500">{props.judgment.confidenceOriginal}%</div>
        </Show>
      </div>
      <Show when={props.judgment.explanation}>
        <p class="text-xs text-gray-600 mt-2">{props.judgment.explanation}</p>
      </Show>
      <Show
        when={
          props.judgment.quotes
          && Array.isArray(props.judgment.quotes)
          && (props.judgment.quotes as string[]).length > 0
        }
      >
        <div class="mt-2 space-y-1">
          <For each={props.judgment.quotes as string[]}>
            {(quote) => {
              return <p class="text-xs text-gray-500 italic">"{quote}"</p>
            }}
          </For>
        </div>
      </Show>
      <Show when={props.judgment.assessments && props.judgment.assessments.length > 0}>
        <div class="mt-2 text-xs">
          <ReviewJudgmentAssessments assessments={props.judgment.assessments!} />
        </div>
      </Show>
    </div>
  )
}

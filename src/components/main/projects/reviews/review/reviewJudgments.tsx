import {createSignal, For, Show} from 'solid-js'

import {ReviewJudgmentItem} from './reviewJudgmentItem.tsx'

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type HumanAnswer = {userName: string; answer: string}

type Judgment = {
  id: string
  promptId?: string
  prompt: {originalText: string; id?: string; promptHeading?: string | null}
  answeredOriginal?: string | null
  confidenceOriginal?: number | null
  explanation?: string | null
  quotes?: unknown
  assessments?: Array<{assessmentIsCorrect?: boolean | null; assessmentComment?: string | null}>
  modelName?: string | null
  modelProvider?: string | null
  modelVersion?: string | null
  snapshotProjectModelName?: string | null
  useTitle?: boolean
  useAbstract?: boolean
  useFulltext?: boolean
  useFulltextNoImages?: boolean
  chunkingStrategy?: string | null
}

type ReviewJudgmentsProps = {
  judgments?: Judgment[]
  setArticleViewToShow: SetArticleViewToShow
  humanJudgmentMode?: 'prompt' | 'summary'
  humanAnswersByPrompt?: Record<string, HumanAnswer[]>
  humanSummaryAnswer?: string | null
  llmSummaryAnswer?: string | null
}

const toSummaryAnswerLabel = (answer: string | null | undefined) => {
  const normalized = String(answer ?? '')
    .trim()
    .toLowerCase()

  return normalized === 'yes'
    ? 'Y'
    : normalized === 'no'
      ? 'N'
      : normalized === 'maybe'
        ? 'M'
        : normalized === 'unsure'
          ? 'U'
          : normalized.length > 0
            ? normalized.slice(0, 1).toUpperCase()
            : '-'
}

export const ReviewJudgments = (props: ReviewJudgmentsProps) => {
  const [isOpen, setIsOpen] = createSignal(true)

  const getPromptId = (judgment: Judgment) => {
    return judgment.prompt?.id || judgment.promptId || undefined
  }

  const count = () => {
    return props.judgments?.length ?? 0
  }

  const summaryAgreementClass = () => {
    const llm = String(props.llmSummaryAnswer ?? '')
      .trim()
      .toLowerCase()
    const human = String(props.humanSummaryAnswer ?? '')
      .trim()
      .toLowerCase()

    return !llm || !human
      ? 'bg-gray-50 border-gray-200'
      : llm === human
        ? 'bg-green-50 border-green-200'
        : llm === 'maybe' || human === 'maybe'
          ? 'bg-yellow-50 border-yellow-200'
          : 'bg-red-50 border-red-200'
  }

  return (
    <div class="bg-white rounded-lg shadow h-fit">
      <div class="p-4 border-b flex items-center justify-between gap-3">
        <div class="flex items-baseline gap-2">
          <h2 class="text-lg font-bold">LLM assessment</h2>
          <span class="text-xs text-gray-500">({count()})</span>
        </div>
        <button
          type="button"
          class="p-1 rounded hover:bg-gray-50"
          aria-expanded={isOpen()}
          onClick={() => {
            setIsOpen(!isOpen())
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke="currentColor"
            class="w-4 h-4 transition-transform duration-200"
            classList={{'rotate-90': isOpen()}}
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>

      <Show when={isOpen()}>
        <Show when={props.humanJudgmentMode === 'summary'}>
          <div class={`mx-4 mt-4 rounded-lg border p-3 ${summaryAgreementClass()}`}>
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-600">Overall decision</div>
            <div class="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div class="text-[11px] font-medium text-gray-500">Human</div>
                <div class="mt-1 flex items-center gap-2">
                  <span class="inline-flex h-7 w-7 items-center justify-center rounded bg-white text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-200">
                    {toSummaryAnswerLabel(props.humanSummaryAnswer)}
                  </span>
                  <span class="text-sm text-gray-700">{props.humanSummaryAnswer ?? '-'}</span>
                </div>
              </div>
              <div>
                <div class="text-[11px] font-medium text-gray-500">AI</div>
                <div class="mt-1 flex items-center gap-2">
                  <span class="inline-flex h-7 w-7 items-center justify-center rounded bg-white text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-200">
                    {toSummaryAnswerLabel(props.llmSummaryAnswer)}
                  </span>
                  <span class="text-sm text-gray-700">{props.llmSummaryAnswer ?? '-'}</span>
                </div>
              </div>
            </div>
          </div>
        </Show>
        <Show
          when={props.judgments && props.judgments.length > 0}
          fallback={<p class="text-gray-500 p-4">No judgments available</p>}
        >
          <div class="p-2">
            <For each={props.judgments}>
              {(judgment) => {
                const promptId = getPromptId(judgment)
                const humanAnswers = () => {
                  return props.humanJudgmentMode === 'summary' || !promptId
                    ? undefined
                    : props.humanAnswersByPrompt?.[promptId]
                }
                return (
                  <ReviewJudgmentItem
                    judgment={judgment}
                    setArticleViewToShow={props.setArticleViewToShow}
                    humanAnswers={humanAnswers()}
                  />
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

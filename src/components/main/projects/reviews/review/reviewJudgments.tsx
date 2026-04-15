import {createSignal, For, onCleanup, Show} from 'solid-js'

import {ReviewJudgmentItem} from './reviewJudgmentItem.tsx'
import {getReviewJudgmentsCopyText} from './reviewJudgmentsCopyText.ts'

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

const toSummaryAnswerDisplay = (answer: string | null | undefined) => {
  const normalized = String(answer ?? '')
    .trim()
    .toLowerCase()

  return normalized === 'yes'
    ? 'Yes'
    : normalized === 'no'
      ? 'No'
      : normalized === 'maybe'
        ? 'Maybe'
        : normalized === 'unsure'
          ? 'Unsure'
          : normalized.length > 0
            ? normalized.slice(0, 1).toUpperCase() + normalized.slice(1)
            : '-'
}

const getSummaryAgreementClassName = (
  llmSummaryAnswer: string | null | undefined,
  humanSummaryAnswer: string | null | undefined,
): string => {
  const llm = String(llmSummaryAnswer ?? '')
    .trim()
    .toLowerCase()
  const human = String(humanSummaryAnswer ?? '')
    .trim()
    .toLowerCase()

  return !llm || !human
    ? 'border-gray-200 bg-gray-50'
    : llm === human
      ? 'border-green-200 bg-green-50'
      : llm === 'maybe' || human === 'maybe'
        ? 'border-yellow-200 bg-yellow-50'
        : 'border-red-200 bg-red-50'
}

export const ReviewJudgments = (props: ReviewJudgmentsProps) => {
  const [isOpen, setIsOpen] = createSignal(true)
  const [copied, setCopied] = createSignal(false)
  let copyFeedbackTimeout: ReturnType<typeof setTimeout> | undefined

  const getPromptId = (judgment: Judgment) => {
    return judgment.prompt?.id || judgment.promptId || undefined
  }

  const count = () => {
    return props.judgments?.length ?? 0
  }

  onCleanup(() => {
    if (copyFeedbackTimeout !== undefined) {
      clearTimeout(copyFeedbackTimeout)
    }
  })

  const showCopyFeedback = () => {
    if (copyFeedbackTimeout !== undefined) {
      clearTimeout(copyFeedbackTimeout)
    }

    setCopied(true)
    copyFeedbackTimeout = setTimeout(() => {
      setCopied(false)
      copyFeedbackTimeout = undefined
    }, 150)
  }

  const handleCopy = () => {
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard
    const text = getReviewJudgmentsCopyText({
      judgments: props.judgments,
      humanJudgmentMode: props.humanJudgmentMode,
      humanAnswersByPrompt: props.humanAnswersByPrompt,
      humanSummaryAnswer: props.humanSummaryAnswer,
      llmSummaryAnswer: props.llmSummaryAnswer,
    })

    if (!clipboard || text.length === 0) {
      return
    }

    void clipboard.writeText(text).then(
      () => {
        showCopyFeedback()
      },
      () => {
        setCopied(false)
      },
    )
  }

  return (
    <div class="bg-white rounded-lg shadow h-fit">
      <div class="p-4 border-b flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="flex items-baseline gap-2">
            <h2 class="text-lg font-bold">LLM assessment</h2>
            <span class="text-xs text-gray-500">({count()})</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-200 bg-white text-sm text-gray-600 transition-colors duration-700 ease-out hover:bg-gray-200 hover:text-gray-900 active:bg-gray-300 active:text-gray-900"
              classList={{'border-gray-300 bg-gray-300 text-gray-900 hover:bg-gray-300': copied()}}
              title={copied() ? 'Copied' : 'Copy LLM assessment'}
              aria-label={copied() ? 'Copied LLM assessment' : 'Copy LLM assessment'}
              onClick={handleCopy}
            >
              ⧉
            </button>
            <span
              aria-live="polite"
              class="min-w-[40px] text-[11px] font-medium text-gray-500 transition-opacity duration-700 ease-out"
              classList={{'opacity-100': copied(), 'opacity-0': !copied()}}
            >
              Copied
            </span>
          </div>
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
          <div
            class={`mx-4 mt-4 rounded-lg border p-3 ${getSummaryAgreementClassName(props.llmSummaryAnswer, props.humanSummaryAnswer)}`}
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-600">Include this study?</div>
            <div class="mt-3 grid grid-cols-2 gap-3">
              <div class="rounded-md border border-white/70 bg-white/80 px-3 py-2">
                <div class="text-[11px] font-medium uppercase tracking-wide text-gray-500">AI</div>
                <div class="mt-1 text-sm font-semibold text-gray-900">
                  {toSummaryAnswerDisplay(props.llmSummaryAnswer)}
                </div>
              </div>
              <div class="rounded-md border border-white/70 bg-white/80 px-3 py-2">
                <div class="text-[11px] font-medium uppercase tracking-wide text-gray-500">Human</div>
                <div class="mt-1 text-sm font-semibold text-gray-900">
                  {toSummaryAnswerDisplay(props.humanSummaryAnswer)}
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

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
  humanAnswersByPrompt?: Record<string, HumanAnswer[]>
}

export const ReviewJudgments = (props: ReviewJudgmentsProps) => {
  const [isOpen, setIsOpen] = createSignal(true)

  const getPromptId = (judgment: Judgment) => {
    return judgment.prompt?.id || judgment.promptId || undefined
  }

  const count = () => {
    return props.judgments?.length ?? 0
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
        <Show
          when={props.judgments && props.judgments.length > 0}
          fallback={<p class="text-gray-500 p-4">No judgments available</p>}
        >
          <div class="p-2">
            <For each={props.judgments}>
              {(judgment) => {
                const promptId = getPromptId(judgment)
                const humanAnswers = () => {
                  return promptId ? props.humanAnswersByPrompt?.[promptId] : undefined
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

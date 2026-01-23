import {For, Show} from 'solid-js'

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
  snapshotProjectModelName?: string | null
  useTitle?: boolean
  useAbstract?: boolean
  useFulltext?: boolean
  useFulltextNoImages?: boolean
}

type ReviewJudgmentsProps = {
  judgments?: Judgment[]
  setArticleViewToShow: SetArticleViewToShow
  humanAnswersByPrompt?: Record<string, HumanAnswer[]>
}

export const ReviewJudgments = (props: ReviewJudgmentsProps) => {
  const getPromptId = (judgment: Judgment) => {
    return judgment.prompt?.id || judgment.promptId || undefined
  }

  return (
    <div class="bg-white rounded-lg shadow h-fit">
      <div class="p-4 border-b">
        <h2 class="text-lg font-bold">LLM assessment</h2>
      </div>
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
    </div>
  )
}

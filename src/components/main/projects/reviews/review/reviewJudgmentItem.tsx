import {createSignal, For, Show} from 'solid-js'

import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../../../../utils/providerModelLabel.ts'
import type {ProviderModelThinkingOption} from '../../../../../utils/providerModelOptions.ts'
import {reviewArticleDetailsDispatchScrollToQuote} from './reviewArticleDetails/reviewArticleDetailsScrollEvents.ts'
import {ReviewJudgmentAssessments} from './reviewJudgmentAssessments.tsx'

type SetArticleViewToShow = (articleViewToShow: string | undefined) => void

type HumanAnswer = {userName: string; answer: string}

const isPlaceholderJudgmentId = (judgmentId: string): boolean => {
  return judgmentId.startsWith('placeholder:')
}

const toThinkingLevelLabel = ({
  modelProvider,
  modelThinking,
  modelVersion,
}: {
  modelProvider: string | null | undefined
  modelThinking: string | null | undefined
  modelVersion: string | null | undefined
}): string => {
  const thinking = String(modelThinking ?? '').trim()
  const provider = String(modelProvider ?? '')
    .trim()
    .toLowerCase()
  const version = String(modelVersion ?? '').trim()
  const hasVersion = version.length > 0
  const hasProvider = provider.length > 0
  const isCodex = provider === 'codex'

  return thinking.length > 0
    ? thinking
    : isCodex
      ? hasVersion
        ? version
        : 'auto'
      : hasVersion
        ? version
        : hasProvider
          ? 'n/a'
          : 'unknown'
}

const toChunkingLabel = (chunkingStrategy: string | null | undefined): string => {
  const strategy = String(chunkingStrategy ?? '').trim()
  return strategy.length > 0 ? `yes (${strategy})` : 'no'
}

type ReviewJudgmentItemProps = {
  judgment: {
    id: string
    promptId?: string
    prompt: {originalText: string; id?: string; contentHash?: string | null; promptHeading?: string | null}
    answeredOriginal?: string | null
    answeredOriginalAsArray?: string[] | null
    confidenceOriginal?: number | null
    explanation?: string | null
    quotes?: unknown
    assessments?: Array<{assessmentIsCorrect?: boolean | null; assessmentComment?: string | null}>
    modelName?: string | null
    modelProvider?: string | null
    modelThinking?: ProviderModelThinkingOption | null
    modelVersion?: string | null
    snapshotProjectModelName?: string | null
    useTitle?: boolean
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    chunkingStrategy?: string | null
  }
  setArticleViewToShow: SetArticleViewToShow
  humanAnswers?: HumanAnswer[]
}

// Normalize an answer for comparison (lowercase, trim)
const normalizeAnswer = (answer: string | null | undefined): string => {
  return (answer ?? '').toLowerCase().trim()
}

export const ReviewJudgmentItem = (props: ReviewJudgmentItemProps) => {
  const [showAllHumanAnswers, setShowAllHumanAnswers] = createSignal(false)

  const isPlaceholder = () => {
    return isPlaceholderJudgmentId(props.judgment.id)
  }

  const promptId = () => {
    return props.judgment.prompt?.id || props.judgment.promptId || undefined
  }
  const modelName = () => {
    // Use modelName (from joined models table) or fall back to snapshotProjectModelName
    return props.judgment.modelName || props.judgment.snapshotProjectModelName || undefined
  }
  const modelLabel = () => {
    const resolvedModelName = modelName()

    return resolvedModelName
      ? appendProviderModelThinkingBadgeLabel({
          label: resolvedModelName,
          thinking: getProviderModelThinkingBadgeValue({
            provider: props.judgment.modelProvider,
            thinking: props.judgment.modelThinking ?? null,
            version: props.judgment.modelVersion,
          }),
        })
      : undefined
  }

  const thinkingLevel = () => {
    return toThinkingLevelLabel({
      modelProvider: props.judgment.modelProvider,
      modelThinking: props.judgment.modelThinking,
      modelVersion: props.judgment.modelVersion,
    })
  }

  const chunking = () => {
    return toChunkingLabel(props.judgment.chunkingStrategy)
  }

  const hasContentFlags = () => {
    const j = props.judgment
    return (
      j.useTitle !== undefined
      || j.useAbstract !== undefined
      || j.useFulltext !== undefined
      || j.useFulltextNoImages !== undefined
    )
  }

  // Get the LLM answer as a normalized string for comparison
  const llmAnswer = () => {
    return normalizeAnswer(props.judgment.answeredOriginal)
  }

  // Compute agreement status: 'none' | 'all' | 'some' | 'no-humans'
  const agreementStatus = () => {
    const humans = props.humanAnswers || []
    if (humans.length === 0) {
      return 'no-humans'
    }
    const llm = llmAnswer()
    const matchCount = humans.filter((h) => {
      return normalizeAnswer(h.answer) === llm
    }).length
    if (matchCount === humans.length) {
      return 'all'
    }
    if (matchCount === 0) {
      return 'none'
    }
    return 'some'
  }

  // Get color class based on agreement status
  const getAnswerColorClass = () => {
    const status = agreementStatus()
    switch (status) {
      case 'all':
        return 'text-green-600 font-semibold'
      case 'none':
        return 'text-red-600 font-semibold'
      case 'some':
        return 'text-orange-500 font-semibold'
      default:
        return 'text-black font-semibold'
    }
  }

  // Determine which human answers to display
  const visibleHumanAnswers = () => {
    const answers = props.humanAnswers || []
    if (answers.length <= 3 || showAllHumanAnswers()) {
      return answers
    }
    return answers.slice(0, 2)
  }

  const hiddenCount = () => {
    const answers = props.humanAnswers || []
    if (answers.length <= 3 || showAllHumanAnswers()) {
      return 0
    }
    return answers.length - 2
  }

  // Get display text for the LLM answer
  const llmAnswerDisplay = () => {
    const asArray = props.judgment.answeredOriginalAsArray
    if (asArray && Array.isArray(asArray) && asArray.length > 0) {
      return asArray
        .map((v) => {
          return v.toUpperCase()
        })
        .join(', ')
    }
    const raw = props.judgment.answeredOriginal ?? ''
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          return (parsed as string[])
            .map((v) => {
              return String(v).toUpperCase()
            })
            .join(', ')
        }
      } catch {
        /* not valid JSON */
      }
    }
    return raw.toUpperCase()
  }

  return (
    <div
      class="border-b last:border-b-0 p-3 hover:bg-gray-50 cursor-pointer transition-colors"
      onPointerEnter={() => {
        props.setArticleViewToShow(props.judgment.id)
      }}
      onPointerLeave={() => {
        props.setArticleViewToShow(undefined)
      }}
    >
      <div class="mb-2">
        <Show when={props.judgment.prompt.promptHeading}>
          <div class="-ml-5 mb-4">
            <span class="inline-block px-2 py-0.5 text-[10px] font-semibold text-white bg-blue-900 rounded-r">
              {props.judgment.prompt.promptHeading}
            </span>
          </div>
        </Show>
        <p class="text-sm font-medium text-gray-900 line-clamp-2" title={props.judgment.prompt.originalText}>
          {props.judgment.prompt.originalText}
        </p>
        <div class="mt-1 text-[11px] text-gray-500 space-y-0.5 break-words">
          {promptId() ? <div>Prompt ID: {String(promptId()).slice(0, 8)}</div> : null}
          {modelLabel() ? <div>Model: {modelLabel()}</div> : null}
          <Show when={!isPlaceholder()}>
            <div>Thinking level: {thinkingLevel()}</div>
            <div>Chunking: {chunking()}</div>
          </Show>
          <Show when={hasContentFlags()}>
            <div class="flex flex-wrap items-center gap-1 mt-0.5">
              <span class="mr-0.5">Content:</span>
              <span
                class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  props.judgment.useTitle ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'
                }`}
              >
                Title
              </span>
              <span
                class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  props.judgment.useAbstract ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'
                }`}
              >
                Abstract
              </span>
              <span
                class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  props.judgment.useFulltext ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'
                }`}
              >
                Full text
              </span>
              <span
                class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  props.judgment.useFulltextNoImages ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-500'
                }`}
              >
                Full text - no images
              </span>
            </div>
          </Show>
        </div>
      </div>

      <div class="mb-2 border-t border-dashed border-gray-200" />

      <div class="flex items-start justify-between gap-2 text-xs">
        <div class="flex items-start gap-2 min-w-0 flex-1">
          <span class="font-medium w-[70px] text-right shrink-0">Answer:</span>
          <span class={`${getAnswerColorClass()} min-w-0 flex-1 break-words`}>{llmAnswerDisplay()}</span>
        </div>
      </div>

      <Show when={props.humanAnswers && props.humanAnswers.length > 0}>
        <div class="mt-1">
          <For each={visibleHumanAnswers()}>
            {(humanAnswer) => {
              return (
                <div class="flex items-start gap-2 text-xs">
                  <span class="font-medium w-[70px] text-right shrink-0">{humanAnswer.userName}:</span>
                  <span
                    class={`${getAnswerColorClass()} min-w-0 flex-1 break-words`}
                    style={{'text-transform': 'uppercase'}}
                  >
                    {humanAnswer.answer}
                  </span>
                </div>
              )
            }}
          </For>
          <Show when={hiddenCount() > 0}>
            <button
              type="button"
              class="text-xs text-gray-500 hover:text-gray-700 underline cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setShowAllHumanAnswers(true)
              }}
            >
              show {hiddenCount()} more...
            </button>
          </Show>
          <Show when={showAllHumanAnswers() && (props.humanAnswers?.length || 0) > 3}>
            <button
              type="button"
              class="text-xs text-gray-500 hover:text-gray-700 underline cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setShowAllHumanAnswers(false)
              }}
            >
              show less
            </button>
          </Show>
        </div>
      </Show>

      <Show when={props.judgment.explanation}>
        <p class="text-xs text-gray-600 mt-2 break-words">{props.judgment.explanation}</p>
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
            {(quote, quoteIndex) => {
              return (
                <button
                  type="button"
                  class="text-xs text-gray-500 italic text-left w-full break-words hover:text-gray-700 hover:bg-gray-50 rounded px-1 -mx-1"
                  onClick={(e) => {
                    e.stopPropagation()
                    reviewArticleDetailsDispatchScrollToQuote({
                      quote,
                      judgmentId: props.judgment.id,
                      quoteIndex: quoteIndex(),
                    })
                  }}
                >
                  "{quote}"
                </button>
              )
            }}
          </For>
        </div>
      </Show>
      <Show when={props.judgment.assessments && props.judgment.assessments.length > 0}>
        <div class="mt-2 text-xs">
          <ReviewJudgmentAssessments assessments={props.judgment.assessments ?? []} />
        </div>
      </Show>
    </div>
  )
}

import {createSignal, onCleanup, onMount, Show} from 'solid-js'

import {decodeAndSanitize} from '../../../../../app/utils/decodeAndSanitize'
import {getArticleUrl} from '../../../../../app/utils/getArticleUrl.ts'
import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetails/reviewArticleDetailsGetHighlightedText.ts'

type Judgment = {
  id: string
  prompt: {originalText: string}
  answeredOriginal?: string | null
  confidenceOriginal?: number | null
  quotes?: string[]
}

type HumanJudgment = {
  id: string
  prompt: {originalText: string}
  answer: string | null
  comment: string | null
  userName?: string
}

type ReviewArticleDetailsProps = {
  article: {articleTitle: string; articleAuthors?: string[] | null; articleSummary?: string | null; articleId: string}
  judgment?: Judgment
  humanJudgment?: HumanJudgment
}

const stickyOffsets = {top: 24, bottom: 24}

const getHighlightedText = (text: string, judgment: Judgment) => {
  const sanitizedText = decodeAndSanitize(text)
  const pieces = reviewArticleDetailsGetHighlightedText(
    sanitizedText,
    new Array(...(judgment.quotes || [])).map((quote) => {
      // replace leading ... and trailing ..., should be better stored in the database
      return quote.replace(/^\.{3}|\.{3}$/g, '')
    }),
    {maxDistance: 1, caseInsensitive: true, fuzzyScanLimit: 'auto'},
  )

  const html = pieces
    .map(([text, isHit]) => {
      return isHit ? `<span class="text-red-500 underline">${text}</span>` : text
    })
    .join('')

  // eslint-disable-next-line solid/no-innerhtml
  return <span innerHTML={html} />
}

export const ReviewArticleDetails = (props: ReviewArticleDetailsProps) => {
  const [stickyTop, setStickyTop] = createSignal<number | undefined>(undefined)
  let containerRef: HTMLDivElement | undefined

  const setStickiness = () => {
    const containerHeight = containerRef?.getBoundingClientRect().height
    if (!containerHeight) {
      setStickyTop(undefined)
      return
    }

    if (containerHeight <= window.innerHeight - stickyOffsets.top) {
      setStickyTop(stickyOffsets.top)
    } else {
      setStickyTop(window.innerHeight - containerHeight - stickyOffsets.bottom)
    }
  }

  onMount(() => {
    setStickiness()
    const resizeObserver = new ResizeObserver(() => {
      setStickiness()
    })
    if (containerRef) {
      resizeObserver.observe(containerRef)
    }
    const handleResize = () => {
      setStickiness()
    }
    window.addEventListener('resize', handleResize)
    onCleanup(() => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
    })
  })

  return (
    <div
      ref={(element) => {
        containerRef = element
      }}
      class="space-y-4"
      classList={{'sticky self-start': stickyTop() !== undefined}}
      style={{top: stickyTop() !== undefined ? `${stickyTop()}px` : undefined}}
    >
      <h1 class="text-2xl font-bold">Article Details</h1>
      <div class="p-6 bg-white rounded-lg shadow">
        <div class="space-y-2">
          <p class="text-lg font-semibold">
            {props.judgment ? (
              getHighlightedText(props.article.articleTitle, props.judgment)
            ) : (
              // eslint-disable-next-line solid/no-innerhtml
              <span innerHTML={decodeAndSanitize(props.article.articleTitle)} />
            )}
          </p>
          <p class="text-gray-600">
            <a
              href={getArticleUrl(props.article.articleId)}
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:underline"
            >
              {props.article.articleId}
            </a>
          </p>
          <Show when={props.article.articleAuthors}>
            <p class="text-gray-600">Authors: {props.article.articleAuthors?.join(', ')}</p>
          </Show>
          <Show when={props.article.articleSummary}>
            <div class="mt-4">
              <h3 class="font-semibold mb-2">Summary</h3>
              <div class="text-gray-700 assessment-container leading-relaxed">
                {props.judgment && props.article.articleSummary ? (
                  getHighlightedText(props.article.articleSummary, props.judgment)
                ) : (
                  // eslint-disable-next-line solid/no-innerhtml
                  <span innerHTML={decodeAndSanitize(props.article.articleSummary ?? '')} />
                )}
              </div>
            </div>
          </Show>
        </div>
      </div>

      {/* Human Judgment Display */}
      <Show when={props.humanJudgment}>
        {(humanJudgment) => {
          const answer = humanJudgment().answer?.toLowerCase() ?? ''
          const isPositive = answer === 'yes' || answer === 'include'
          const isNegative = answer === 'no' || answer === 'exclude'
          const isUnsure = answer === 'unsure' || answer === 'maybe'
          const isOther = !isPositive && !isNegative && !isUnsure

          return (
            <div class="p-6 bg-white rounded-lg shadow border-l-4 border-green-500">
              <div class="flex items-center gap-2 mb-4">
                <svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
                <h2 class="text-lg font-semibold text-green-800">Human Assessment</h2>
                <Show when={humanJudgment().userName}>
                  <span class="text-sm text-gray-500">by {humanJudgment().userName}</span>
                </Show>
              </div>

              <div class="space-y-3">
                <div>
                  <p class="text-sm text-gray-500 mb-1">Prompt</p>
                  <p class="text-gray-800">{humanJudgment().prompt.originalText}</p>
                </div>

                <div>
                  <p class="text-sm text-gray-500 mb-1">Answer</p>
                  <p class="text-lg font-medium">
                    <span
                      class="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold"
                      classList={{
                        'bg-green-100 text-green-800': isPositive,
                        'bg-red-100 text-red-800': isNegative,
                        'bg-yellow-100 text-yellow-800': isUnsure,
                        'bg-gray-100 text-gray-800': isOther,
                      }}
                    >
                      {humanJudgment().answer ?? 'No answer'}
                    </span>
                  </p>
                </div>

                <Show when={humanJudgment().comment}>
                  <div>
                    <p class="text-sm text-gray-500 mb-1">Comment</p>
                    <p class="text-gray-700 bg-gray-50 p-3 rounded italic">{humanJudgment().comment}</p>
                  </div>
                </Show>
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

import {createSignal, onCleanup, onMount, Show} from 'solid-js'

import {decodeAndSanitize} from '../../../../../app/utils/decodeAndSanitize'
import {getArticleUrl} from '../../../../../app/utils/getArticleUrl.ts'
import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetails/reviewArticleDetailsGetHighlightedText.ts'

type DecodeAndSanitizeOptions = Parameters<typeof decodeAndSanitize>[1]

type Judgment = {
  id: string
  prompt: {originalText: string}
  answeredOriginal?: string | null
  confidenceOriginal?: number | null
  quotes?: string[]
}

type ReviewArticleDetailsArticle = {
  articleTitle: string
  articleAuthors?: string[] | null
  articleSummary?: string | null
  articleId: string
  fullText?: string | null
  fullTextHtml?: string | null
  fullTextPDF?: string | null
}

type ReviewArticleDetailsProps = {
  article: ReviewArticleDetailsArticle
  judgment?: Judgment
  showTitle?: boolean
  enableSticky?: boolean
}

const stickyOffsets = {top: 24, bottom: 24}

const toNonEmptyStringOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? value : null
}

const getArticleFulltextForDisplay = (article: ReviewArticleDetailsArticle) => {
  return toNonEmptyStringOrNull(article.fullTextHtml) ?? toNonEmptyStringOrNull(article.fullText)
}

const getArticleFulltextSanitizeOptions = (article: ReviewArticleDetailsArticle): DecodeAndSanitizeOptions => {
  const isHtml = Boolean(toNonEmptyStringOrNull(article.fullTextHtml))
  return {convertNewlines: !isHtml}
}

/**
 * Creates highlighted text with clickable highlights that scroll to fulltext.
 * Returns both the JSX element and a function to scroll to first highlight in fulltext.
 */
const getHighlightedTextWithScrollHandler = (
  text: string,
  judgment: Judgment,
  options?: {onHighlightClick?: (quote: string) => void; highlightId?: string},
  sanitizeOptions?: DecodeAndSanitizeOptions,
) => {
  const sanitizedText = decodeAndSanitize(text, sanitizeOptions)
  const normalizedQuotes = (judgment.quotes || []).map((quote) => {
    return quote.replace(/^\.{3}|\.{3}$/g, '')
  })

  const pieces = reviewArticleDetailsGetHighlightedText(sanitizedText, normalizedQuotes, {
    maxDistance: 1,
    caseInsensitive: true,
    fuzzyScanLimit: 'auto',
  })

  const html = pieces
    .map(([pieceText, isHit], index) => {
      if (isHit) {
        const dataAttr = options?.highlightId ? `data-highlight-id="${options.highlightId}-${index}"` : ''
        const clickableClass = options?.onHighlightClick ? 'cursor-pointer hover:bg-red-100' : ''
        return `<span class="text-red-500 underline ${clickableClass}" ${dataAttr}>${pieceText}</span>`
      }
      return pieceText
    })
    .join('')

  // eslint-disable-next-line solid/no-innerhtml
  return <span innerHTML={html} />
}

/**
 * Simple highlighted text (backward compatible)
 */
const getHighlightedText = (text: string, judgment: Judgment) => {
  return getHighlightedTextWithScrollHandler(text, judgment)
}

/**
 * Creates highlighted fulltext with data attributes for scroll targeting
 */
const getHighlightedFulltext = (text: string, judgment: Judgment, sanitizeOptions?: DecodeAndSanitizeOptions) => {
  const sanitizedText = decodeAndSanitize(text, sanitizeOptions)
  const normalizedQuotes = (judgment.quotes || []).map((quote) => {
    return quote.replace(/^\.{3}|\.{3}$/g, '')
  })

  const pieces = reviewArticleDetailsGetHighlightedText(sanitizedText, normalizedQuotes, {
    maxDistance: 1,
    caseInsensitive: true,
    fuzzyScanLimit: 'auto',
  })

  const html = pieces
    .map(([pieceText, isHit], index) => {
      if (isHit) {
        return `<span class="text-red-500 underline bg-red-50 scroll-mt-4" data-fulltext-highlight="${index}">${pieceText}</span>`
      }
      return pieceText
    })
    .join('')

  // eslint-disable-next-line solid/no-innerhtml
  return <span innerHTML={html} />
}

export const ReviewArticleDetails = (props: ReviewArticleDetailsProps) => {
  const [stickyTop, setStickyTop] = createSignal<number | undefined>(undefined)
  const [isFulltextExpanded, setIsFulltextExpanded] = createSignal(false)
  let containerRef: HTMLDivElement | undefined
  let fulltextContainerRef: HTMLDivElement | undefined
  const fulltextForDisplay = () => {
    return getArticleFulltextForDisplay(props.article)
  }
  const fulltextSanitizeOptions = () => {
    return getArticleFulltextSanitizeOptions(props.article)
  }

  // Default props
  const showTitle = () => {
    return props.showTitle ?? true
  }
  const enableSticky = () => {
    return props.enableSticky ?? true
  }

  const setStickiness = () => {
    if (!enableSticky()) {
      setStickyTop(undefined)
      return
    }
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

  const scrollToFirstHighlightInFulltext = () => {
    if (!fulltextContainerRef) return

    // First expand the fulltext section if collapsed
    if (!isFulltextExpanded()) {
      setIsFulltextExpanded(true)
      // Wait for DOM update, then scroll
      requestAnimationFrame(() => {
        const firstHighlight = fulltextContainerRef?.querySelector('[data-fulltext-highlight="0"]')
        if (firstHighlight) {
          firstHighlight.scrollIntoView({behavior: 'smooth', block: 'center'})
        }
      })
    } else {
      const firstHighlight = fulltextContainerRef?.querySelector('[data-fulltext-highlight="0"]')
      if (firstHighlight) {
        firstHighlight.scrollIntoView({behavior: 'smooth', block: 'center'})
      }
    }
  }

  // Handle clicks on highlights in title/summary to scroll to fulltext
  const handleTitleSummaryClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (target.classList.contains('text-red-500') && target.classList.contains('underline')) {
      // Only scroll if fulltext is available
      if (fulltextForDisplay()) {
        scrollToFirstHighlightInFulltext()
      }
    }
  }

  onMount(() => {
    if (enableSticky()) {
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
    }
  })

  return (
    <div
      ref={(element) => {
        containerRef = element
      }}
      class="space-y-4"
      classList={{'sticky self-start': enableSticky() && stickyTop() !== undefined}}
      style={{top: enableSticky() && stickyTop() !== undefined ? `${stickyTop()}px` : undefined}}
    >
      <Show when={showTitle()}>
        <h1 class="text-2xl font-bold">Article Details</h1>
      </Show>

      <div class="p-6 bg-white rounded-lg shadow">
        <div class="space-y-2">
          {/* Title with clickable highlights */}
          <p class="text-lg font-semibold" onClick={handleTitleSummaryClick}>
            {props.judgment ? (
              getHighlightedText(props.article.articleTitle, props.judgment)
            ) : (
              // eslint-disable-next-line solid/no-innerhtml
              <span innerHTML={decodeAndSanitize(props.article.articleTitle)} />
            )}
          </p>

          {/* Article ID link */}
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

          {/* Authors */}
          <Show when={props.article.articleAuthors}>
            <p class="text-gray-600">Authors: {props.article.articleAuthors?.join(', ')}</p>
          </Show>

          {/* PDF Download Button */}
          <Show when={props.article.fullTextPDF}>
            <div class="mt-2">
              <a
                href={`/${props.article.fullTextPDF}`}
                download
                class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="w-4 h-4"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                  />
                </svg>
                Download PDF
              </a>
            </div>
          </Show>

          {/* Summary with clickable highlights */}
          <Show when={props.article.articleSummary}>
            <div class="mt-4">
              <h3 class="font-semibold mb-2">Summary</h3>
              <div class="text-gray-700 assessment-container leading-relaxed" onClick={handleTitleSummaryClick}>
                {props.judgment && props.article.articleSummary ? (
                  getHighlightedText(props.article.articleSummary, props.judgment)
                ) : (
                  // eslint-disable-next-line solid/no-innerhtml
                  <span innerHTML={decodeAndSanitize(props.article.articleSummary ?? '')} />
                )}
              </div>
            </div>
          </Show>

          {/* Full Text Section (Collapsible) */}
          <Show when={fulltextForDisplay()}>
            {(fulltextValue) => {
              return (
                <div class="mt-4">
                  <button
                    type="button"
                    onClick={() => {
                      return setIsFulltextExpanded(!isFulltextExpanded())
                    }}
                    class="flex items-center gap-2 font-semibold text-gray-800 hover:text-gray-600 transition-colors"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke-width="2"
                      stroke="currentColor"
                      class="w-4 h-4 transition-transform duration-200"
                      classList={{'rotate-90': isFulltextExpanded()}}
                    >
                      <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                    Full Text
                    <span class="text-sm font-normal text-gray-500">
                      ({Math.round((fulltextValue()?.length ?? 0) / 1000)}k characters)
                    </span>
                  </button>

                  <Show when={isFulltextExpanded()}>
                    <div
                      ref={(el) => {
                        fulltextContainerRef = el
                      }}
                      class="mt-2 border-l border-gray-400 pl-[25px] text-gray-700 assessment-container leading-relaxed"
                    >
                      {props.judgment ? (
                        getHighlightedFulltext(fulltextValue() ?? '', props.judgment, fulltextSanitizeOptions())
                      ) : (
                        // eslint-disable-next-line solid/no-innerhtml
                        <span innerHTML={decodeAndSanitize(fulltextValue() ?? '', fulltextSanitizeOptions())} />
                      )}
                    </div>
                  </Show>
                </div>
              )
            }}
          </Show>
        </div>
      </div>
    </div>
  )
}

import {createEffect, createMemo, createSignal, onCleanup, onMount, Show} from 'solid-js'

import {decodeAndSanitize} from '../../../../../app/utils/decodeAndSanitize'
import {getArticleUrl} from '../../../../../app/utils/getArticleUrl.ts'

type DecodeAndSanitizeOptions = Parameters<typeof decodeAndSanitize>[1]

type Judgment = {
  id: string
  prompt: {originalText: string}
  answeredOriginal?: string | null
  confidenceOriginal?: number | null
  quotes?: unknown
}

type ReviewArticleDetailsArticle = {
  id?: string
  articleTitle: string
  articleAuthors?: string[] | null
  articleSummary?: string | null
  articleId: string | null
  fullText?: string | null
  fullTextHtml?: string | null
  fullTextPDF?: string | null
  contentHash?: string | null
}

type ReviewArticleDetailsProps = {
  article: ReviewArticleDetailsArticle
  judgment?: Judgment
  showTitle?: boolean
  enableSticky?: boolean
  isFulltextExpanded?: boolean
  setIsFulltextExpanded?: (isFulltextExpanded: boolean) => void
  /** Controls which content to display: 'all' (default), 'summary' (title/summary only), or 'fulltext' (full text only) */
  viewMode?: 'all' | 'summary' | 'fulltext'
  /** Hide the PDF download button (useful when it's displayed elsewhere, e.g., in tabs bar) */
  hidePdfButton?: boolean
}

const stickyOffsets = {top: 24, bottom: 24}

type HighlightTextKind = 'title' | 'summary'

type FulltextHighlightWorkerRequest =
  | {type: 'setText'; text: string}
  | {type: 'clear'}
  | {type: 'highlight'; requestId: number; cacheKey: string; quotes: string[]}
  | {
      type: 'highlightText'
      requestId: number
      cacheKey: string
      kind: HighlightTextKind
      text: string
      quotes: string[]
    }

type FulltextHighlightWorkerResponse =
  | {type: 'highlightResult'; requestId: number; cacheKey: string; html: string}
  | {type: 'highlightTextResult'; requestId: number; cacheKey: string; kind: HighlightTextKind; html: string}

const createFulltextHighlightWorker = (): Worker | undefined => {
  return typeof Worker === 'undefined'
    ? undefined
    : new Worker(new URL('./reviewArticleDetails/reviewArticleDetailsHighlightWorker.ts', import.meta.url), {
        type: 'module',
      })
}

const getArticleCacheKey = (article: ReviewArticleDetailsArticle): string => {
  const id = article.id ?? undefined
  const externalId = article.articleId ?? undefined
  const title = article.articleTitle
  const contentHash = article.contentHash ?? undefined
  const base = id ?? externalId ?? title
  return contentHash ? `${base}::${contentHash}` : base
}

const toNonEmptyStringOrNull = (value: string | null | undefined): string | null | undefined => {
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

const getNormalizedQuotes = (judgment: Judgment | undefined): string[] => {
  const quotes = judgment && Array.isArray(judgment.quotes) ? judgment.quotes : []
  return (quotes as string[])
    .map((quote) => {
      return quote.replace(/^\.{3}|\.{3}$/g, '')
    })
    .filter(Boolean)
}

export const ReviewArticleDetails = (props: ReviewArticleDetailsProps) => {
  const [stickyTop, setStickyTop] = createSignal<number | undefined>(undefined)
  const [localIsFulltextExpanded, setLocalIsFulltextExpanded] = createSignal(false)
  const [highlightedFulltextHtml, setHighlightedFulltextHtml] = createSignal<string | undefined>(undefined)
  const [highlightedTitleHtml, setHighlightedTitleHtml] = createSignal<string | undefined>(undefined)
  const [highlightedSummaryHtml, setHighlightedSummaryHtml] = createSignal<string | undefined>(undefined)
  let fulltextHighlightWorker: Worker | undefined = undefined
  let activeHighlightRequestId = 0
  let activeHighlightCacheKey: string | undefined
  let highlightDebounceTimeout: number | undefined
  let lastFulltextSentToWorker: string | undefined
  let activeTitleHighlightRequestId = 0
  let activeTitleHighlightCacheKey: string | undefined
  let activeSummaryHighlightRequestId = 0
  let activeSummaryHighlightCacheKey: string | undefined
  const isFulltextExpandedControlled = () => {
    return props.isFulltextExpanded !== undefined && props.setIsFulltextExpanded !== undefined
  }
  const isFulltextExpanded = () => {
    return isFulltextExpandedControlled() ? (props.isFulltextExpanded ?? false) : localIsFulltextExpanded()
  }
  const setIsFulltextExpanded = (value: boolean) => {
    const setControlled = props.setIsFulltextExpanded
    return isFulltextExpandedControlled() && setControlled ? setControlled(value) : setLocalIsFulltextExpanded(value)
  }
  let containerRef: HTMLDivElement | undefined
  let fulltextContainerRef: HTMLDivElement | undefined
  const fulltextForDisplay = () => {
    return getArticleFulltextForDisplay(props.article)
  }
  const fulltextSanitizeOptions = () => {
    return getArticleFulltextSanitizeOptions(props.article)
  }

  const articleCacheKey = createMemo(() => {
    return getArticleCacheKey(props.article)
  })

  const sanitizedFulltext = createMemo(() => {
    const text = fulltextForDisplay() ?? ''
    return text ? decodeAndSanitize(text, fulltextSanitizeOptions()) : ''
  })

  const sanitizedTitle = createMemo(() => {
    return decodeAndSanitize(props.article.articleTitle)
  })

  const sanitizedSummary = createMemo(() => {
    return decodeAndSanitize(props.article.articleSummary ?? '')
  })

  // Default props
  const showTitle = () => {
    return props.showTitle ?? true
  }
  const enableSticky = () => {
    return props.enableSticky ?? true
  }
  const viewMode = () => {
    return props.viewMode ?? 'all'
  }
  const hidePdfButton = () => {
    return props.hidePdfButton ?? false
  }

  const shouldComputeFulltextHighlight = () => {
    const mode = viewMode()
    return mode === 'fulltext' || (mode === 'all' && isFulltextExpanded())
  }

  const shouldComputeTitleSummaryHighlight = () => {
    const mode = viewMode()
    return mode === 'all' || mode === 'summary'
  }

  const getFulltextHighlightWorker = () => {
    const existing = fulltextHighlightWorker
    if (existing) return existing

    const created = createFulltextHighlightWorker()
    if (!created) return undefined

    created.onmessage = (event: MessageEvent<FulltextHighlightWorkerResponse>) => {
      const msg = event.data
      if (
        msg.type === 'highlightResult'
        && msg.requestId === activeHighlightRequestId
        && msg.cacheKey === activeHighlightCacheKey
      ) {
        setHighlightedFulltextHtml(msg.html)
      }
      if (
        msg.type === 'highlightTextResult'
        && msg.kind === 'title'
        && msg.requestId === activeTitleHighlightRequestId
        && msg.cacheKey === activeTitleHighlightCacheKey
      ) {
        setHighlightedTitleHtml(msg.html)
      }
      if (
        msg.type === 'highlightTextResult'
        && msg.kind === 'summary'
        && msg.requestId === activeSummaryHighlightRequestId
        && msg.cacheKey === activeSummaryHighlightCacheKey
      ) {
        setHighlightedSummaryHtml(msg.html)
      }
    }

    fulltextHighlightWorker = created
    return created
  }

  createEffect(() => {
    const shouldCompute = shouldComputeFulltextHighlight()
    if (!shouldCompute) return

    const worker = getFulltextHighlightWorker()
    if (!worker) return

    const text = sanitizedFulltext()
    if (lastFulltextSentToWorker === text) return
    lastFulltextSentToWorker = text
    return worker.postMessage({type: 'setText', text} as FulltextHighlightWorkerRequest)
  })

  createEffect(() => {
    const shouldCompute = shouldComputeTitleSummaryHighlight()
    const judgment = props.judgment

    if (!shouldCompute || !judgment) {
      activeTitleHighlightCacheKey = undefined
      setHighlightedTitleHtml(undefined)
      return
    }

    const worker = getFulltextHighlightWorker()
    if (!worker) {
      activeTitleHighlightCacheKey = undefined
      setHighlightedTitleHtml(undefined)
      return
    }

    const quotes = getNormalizedQuotes(judgment)
    if (quotes.length === 0) {
      activeTitleHighlightCacheKey = undefined
      setHighlightedTitleHtml(undefined)
      return
    }

    const text = sanitizedTitle()
    if (!text) {
      activeTitleHighlightCacheKey = undefined
      setHighlightedTitleHtml(undefined)
      return
    }

    const requestId = activeTitleHighlightRequestId + 1
    activeTitleHighlightRequestId = requestId
    const cacheKey = `${articleCacheKey()}::${judgment.id}::title`
    activeTitleHighlightCacheKey = cacheKey
    setHighlightedTitleHtml(undefined)
    return worker.postMessage({
      type: 'highlightText',
      requestId,
      cacheKey,
      kind: 'title',
      text,
      quotes,
    } as FulltextHighlightWorkerRequest)
  })

  createEffect(() => {
    const shouldCompute = shouldComputeTitleSummaryHighlight() && Boolean(props.article.articleSummary)
    const judgment = props.judgment

    if (!shouldCompute || !judgment) {
      activeSummaryHighlightCacheKey = undefined
      setHighlightedSummaryHtml(undefined)
      return
    }

    const worker = getFulltextHighlightWorker()
    if (!worker) {
      activeSummaryHighlightCacheKey = undefined
      setHighlightedSummaryHtml(undefined)
      return
    }

    const quotes = getNormalizedQuotes(judgment)
    if (quotes.length === 0) {
      activeSummaryHighlightCacheKey = undefined
      setHighlightedSummaryHtml(undefined)
      return
    }

    const text = sanitizedSummary()
    if (!text) {
      activeSummaryHighlightCacheKey = undefined
      setHighlightedSummaryHtml(undefined)
      return
    }

    const requestId = activeSummaryHighlightRequestId + 1
    activeSummaryHighlightRequestId = requestId
    const cacheKey = `${articleCacheKey()}::${judgment.id}::summary`
    activeSummaryHighlightCacheKey = cacheKey
    setHighlightedSummaryHtml(undefined)
    return worker.postMessage({
      type: 'highlightText',
      requestId,
      cacheKey,
      kind: 'summary',
      text,
      quotes,
    } as FulltextHighlightWorkerRequest)
  })

  createEffect(() => {
    if (highlightDebounceTimeout !== undefined) {
      window.clearTimeout(highlightDebounceTimeout)
      highlightDebounceTimeout = undefined
    }

    const judgment = props.judgment
    const shouldCompute = shouldComputeFulltextHighlight()
    if (!shouldCompute) {
      activeHighlightCacheKey = undefined
      setHighlightedFulltextHtml(undefined)
      return
    }

    const worker = getFulltextHighlightWorker()
    const canCompute = Boolean(worker)

    if (!judgment || !canCompute) {
      activeHighlightCacheKey = undefined
      setHighlightedFulltextHtml(undefined)
      return
    }

    const text = sanitizedFulltext()
    if (!text) {
      activeHighlightCacheKey = undefined
      setHighlightedFulltextHtml(undefined)
      return
    }

    const quotes = getNormalizedQuotes(judgment)
    if (quotes.length === 0) {
      activeHighlightCacheKey = undefined
      setHighlightedFulltextHtml(undefined)
      return
    }

    const requestId = activeHighlightRequestId + 1
    activeHighlightRequestId = requestId
    const cacheKey = `${articleCacheKey()}::${judgment.id}`
    activeHighlightCacheKey = cacheKey
    setHighlightedFulltextHtml(undefined)

    highlightDebounceTimeout = window.setTimeout(() => {
      return worker?.postMessage({type: 'highlight', requestId, cacheKey, quotes} as FulltextHighlightWorkerRequest)
    }, 75)
  })

  onCleanup(() => {
    if (highlightDebounceTimeout !== undefined) {
      window.clearTimeout(highlightDebounceTimeout)
    }
    if (fulltextHighlightWorker) {
      fulltextHighlightWorker.postMessage({type: 'clear'} as FulltextHighlightWorkerRequest)
      fulltextHighlightWorker.terminate()
    }
  })

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

      <div class="p-6 bg-white rounded-lg shadow" classList={{'rounded-t-none': viewMode() !== 'all'}}>
        <div class="space-y-2">
          {/* Title with clickable highlights - shown in summary and all modes */}
          <Show when={viewMode() === 'all' || viewMode() === 'summary'}>
            <p class="text-lg font-semibold" onClick={handleTitleSummaryClick}>
              <Show
                when={props.judgment && highlightedTitleHtml()}
                fallback={
                  // eslint-disable-next-line solid/no-innerhtml
                  <span innerHTML={sanitizedTitle()} />
                }
              >
                {(html) => {
                  // eslint-disable-next-line solid/no-innerhtml
                  return <span innerHTML={html()} />
                }}
              </Show>
            </p>
          </Show>

          {/* Article ID link - shown in summary and all modes */}
          <Show when={viewMode() === 'all' || viewMode() === 'summary'}>
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
          </Show>

          {/* PDF Download Button - hidden when using tabs (button is in tab bar) */}
          <Show when={!hidePdfButton() && props.article.fullTextPDF}>
            <div class="mt-2">
              <a
                href={`/${props.article.fullTextPDF}`}
                download=""
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

          {/* Summary with clickable highlights - shown in summary and all modes */}
          <Show when={(viewMode() === 'all' || viewMode() === 'summary') && props.article.articleSummary}>
            <div class="mt-4">
              <h3 class="font-semibold mb-2">Summary</h3>
              <div class="text-gray-700 assessment-container leading-relaxed" onClick={handleTitleSummaryClick}>
                <Show
                  when={props.judgment && highlightedSummaryHtml()}
                  fallback={
                    // eslint-disable-next-line solid/no-innerhtml
                    <span innerHTML={sanitizedSummary()} />
                  }
                >
                  {(html) => {
                    // eslint-disable-next-line solid/no-innerhtml
                    return <span innerHTML={html()} />
                  }}
                </Show>
              </div>
            </div>
          </Show>

          {/* Full Text Section - Collapsible in 'all' mode, always expanded in 'fulltext' mode */}
          <Show when={(viewMode() === 'all' || viewMode() === 'fulltext') && fulltextForDisplay()}>
            {(fulltextValue) => {
              return (
                <div class="mt-4">
                  {/* Show collapsible header only in 'all' mode */}
                  <Show when={viewMode() === 'all'}>
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
                  </Show>

                  {/* Show fulltext content either when expanded (all mode) or always (fulltext mode) */}
                  <Show when={viewMode() === 'fulltext' || isFulltextExpanded()}>
                    <div
                      ref={(el) => {
                        fulltextContainerRef = el
                      }}
                      class="text-gray-700 assessment-container leading-relaxed"
                      classList={{'mt-2 border-l border-gray-400 pl-[25px]': viewMode() === 'all'}}
                    >
                      <Show
                        when={props.judgment && highlightedFulltextHtml()}
                        fallback={
                          // eslint-disable-next-line solid/no-innerhtml
                          <span innerHTML={sanitizedFulltext()} />
                        }
                      >
                        {(html) => {
                          // eslint-disable-next-line solid/no-innerhtml
                          return <span innerHTML={html()} />
                        }}
                      </Show>
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

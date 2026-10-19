import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText'
import {
  reviewArticleDetailsGetHighlightedTextHtml,
  reviewArticleDetailsGetHighlightOptions,
  type ReviewArticleDetailsHighlightTextKind as HighlightTextKind,
} from './reviewArticleDetailsHighlightTextHtml.ts'

type HighlightRequest = {type: 'highlight'; requestId: number; cacheKey: string; quotes: string[]}

type HighlightTextRequest = {
  type: 'highlightText'
  requestId: number
  cacheKey: string
  kind: HighlightTextKind
  text: string
  quotes: string[]
}

type SetTextRequest = {type: 'setText'; text: string}

type ClearRequest = {type: 'clear'}

type WorkerRequest = HighlightRequest | HighlightTextRequest | SetTextRequest | ClearRequest

type HighlightResponse = {type: 'highlightResult'; requestId: number; cacheKey: string; html: string}

type HighlightTextResponse = {
  type: 'highlightTextResult'
  requestId: number
  cacheKey: string
  kind: HighlightTextKind
  html: string
}

let fulltext: string | undefined

const hitRangesByCacheKey = new Map<string, Array<[number, number]>>()

const highlightedTextByCacheKey = new Map<string, string>()

const getHitRangesFromPieces = (pieces: Array<[string, boolean]>): Array<[number, number]> => {
  const initial = {offset: 0, ranges: [] as Array<[number, number]>}
  const reduced = pieces.reduce((acc, [text, isHit]) => {
    const start = acc.offset
    const end = acc.offset + text.length
    const ranges = isHit ? [...acc.ranges, [start, end] as [number, number]] : acc.ranges
    return {offset: end, ranges}
  }, initial)
  return reduced.ranges
}

const getHighlightedHtmlFromRanges = (text: string, ranges: Array<[number, number]>): string => {
  if (ranges.length === 0) return text

  const initial = {cursor: 0, html: ''}

  const reduced = ranges.reduce((acc, [start, end], index) => {
    const before = text.slice(acc.cursor, start)
    const inside = text.slice(start, end)
    const highlighted = `<span class="text-red-500 underline scroll-mt-4" data-review-highlight="true" data-fulltext-highlight="${index}">${inside}</span>`
    return {cursor: end, html: `${acc.html}${before}${highlighted}`}
  }, initial)

  return `${reduced.html}${text.slice(reduced.cursor)}`
}

const handleSetText = (text: string) => {
  if (fulltext === text) return
  fulltext = text
  hitRangesByCacheKey.clear()
}

const handleClear = () => {
  fulltext = undefined
  hitRangesByCacheKey.clear()
  highlightedTextByCacheKey.clear()
}

const handleHighlight = (request: HighlightRequest): HighlightResponse => {
  const text = fulltext ?? ''
  if (!text || request.quotes.length === 0) {
    return {type: 'highlightResult', requestId: request.requestId, cacheKey: request.cacheKey, html: text}
  }

  const cachedRanges = hitRangesByCacheKey.get(request.cacheKey)
  if (cachedRanges) {
    return {
      type: 'highlightResult',
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      html: getHighlightedHtmlFromRanges(text, cachedRanges),
    }
  }

  const options = reviewArticleDetailsGetHighlightOptions(text.length)
  const pieces = reviewArticleDetailsGetHighlightedText(text, request.quotes, options)
  const ranges = getHitRangesFromPieces(pieces)
  hitRangesByCacheKey.set(request.cacheKey, ranges)
  return {
    type: 'highlightResult',
    requestId: request.requestId,
    cacheKey: request.cacheKey,
    html: getHighlightedHtmlFromRanges(text, ranges),
  }
}

const handleHighlightText = (request: HighlightTextRequest): HighlightTextResponse => {
  if (!request.text || request.quotes.length === 0) {
    return {
      type: 'highlightTextResult',
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      kind: request.kind,
      html: request.text,
    }
  }

  const cached = highlightedTextByCacheKey.get(request.cacheKey)
  if (cached) {
    return {
      type: 'highlightTextResult',
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      kind: request.kind,
      html: cached,
    }
  }

  const html = reviewArticleDetailsGetHighlightedTextHtml({
    kind: request.kind,
    quotes: request.quotes,
    text: request.text,
  })

  highlightedTextByCacheKey.set(request.cacheKey, html)
  return {
    type: 'highlightTextResult',
    requestId: request.requestId,
    cacheKey: request.cacheKey,
    kind: request.kind,
    html,
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'setText') {
    handleSetText(msg.text)
  }
  if (msg.type === 'clear') {
    handleClear()
  }
  if (msg.type === 'highlight') {
    const response = handleHighlight(msg)
    ;(self as unknown as {postMessage: (message: unknown) => void}).postMessage(response)
  }
  if (msg.type === 'highlightText') {
    const response = handleHighlightText(msg)
    ;(self as unknown as {postMessage: (message: unknown) => void}).postMessage(response)
  }
}

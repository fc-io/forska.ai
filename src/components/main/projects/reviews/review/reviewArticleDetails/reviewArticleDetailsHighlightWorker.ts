import {reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText'

type HighlightRequest = {type: 'highlight'; requestId: number; cacheKey: string; quotes: string[]}

type SetTextRequest = {type: 'setText'; text: string}

type ClearRequest = {type: 'clear'}

type WorkerRequest = HighlightRequest | SetTextRequest | ClearRequest

type HighlightResponse = {type: 'highlightResult'; requestId: number; cacheKey: string; html: string}

let fulltext: string | undefined

const hitRangesByCacheKey = new Map<string, Array<[number, number]>>()

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
    const highlighted = `<span class="text-red-500 underline bg-red-50 scroll-mt-4" data-fulltext-highlight="${index}">${inside}</span>`
    return {cursor: end, html: `${acc.html}${before}${highlighted}`}
  }, initial)

  return `${reduced.html}${text.slice(reduced.cursor)}`
}

const getHighlightOptions = (textLength: number) => {
  const useFuzzy = textLength > 0 && textLength <= 200_000
  return useFuzzy
    ? {maxDistance: 1, caseInsensitive: true, fuzzyScanLimit: 10_000 as const}
    : {maxDistance: 0, caseInsensitive: true}
}

const handleSetText = (text: string) => {
  fulltext = text
  hitRangesByCacheKey.clear()
}

const handleClear = () => {
  fulltext = undefined
  hitRangesByCacheKey.clear()
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

  const options = getHighlightOptions(text.length)
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
}

import {type HighlightOptions, reviewArticleDetailsGetHighlightedText} from './reviewArticleDetailsGetHighlightedText'

export type ReviewArticleDetailsHighlightTextKind = 'title' | 'summary' | 'metadata'

const exactHighlightOptions: HighlightOptions = {maxDistance: 0, caseInsensitive: true}

export const reviewArticleDetailsGetHighlightOptions = (textLength: number): HighlightOptions => {
  const useFuzzy = textLength > 0 && textLength <= 200_000
  return useFuzzy ? {maxDistance: 1, caseInsensitive: true, fuzzyScanLimit: 10_000} : exactHighlightOptions
}

const getHighlightTextOptions = (kind: ReviewArticleDetailsHighlightTextKind, textLength: number) => {
  return kind === 'metadata' ? exactHighlightOptions : reviewArticleDetailsGetHighlightOptions(textLength)
}

export const reviewArticleDetailsGetHighlightedTextHtml = (params: {
  kind: ReviewArticleDetailsHighlightTextKind
  quotes: string[]
  text: string
}): string => {
  const pieces = reviewArticleDetailsGetHighlightedText(
    params.text,
    params.quotes,
    getHighlightTextOptions(params.kind, params.text.length),
  )

  return pieces
    .map(([pieceText, isHit]) => {
      return isHit ? `<span class="text-red-500 underline" data-review-highlight="true">${pieceText}</span>` : pieceText
    })
    .join('')
}

export const reviewArticleDetailsScrollToQuoteEventName = 'reviewArticleDetails:scrollToQuote'

export type ReviewArticleDetailsScrollToQuoteDetail = {quote: string; judgmentId?: string; quoteIndex?: number}

export const reviewArticleDetailsDispatchScrollToQuote = (detail: ReviewArticleDetailsScrollToQuoteDetail) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(reviewArticleDetailsScrollToQuoteEventName, {detail}))
}

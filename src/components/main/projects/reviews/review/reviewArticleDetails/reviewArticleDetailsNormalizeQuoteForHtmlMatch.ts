const stripOuterEllipses = (s: string): string => {
  return s.replace(/^(?:\.{3}|\u2026)+|(?:\.{3}|\u2026)+$/g, '')
}

const escapeAmpersands = (s: string): string => {
  return s.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[a-fA-F0-9]+);)/g, '&amp;')
}

const escapeAngleBracketsOutsideTags = (s: string): string => {
  return s
    .split(/(<[A-Za-z/!][^>]*>)/g)
    .map((part) => {
      const isTag = /^<[A-Za-z/!][^>]*>$/.test(part)
      return isTag ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
    .join('')
}

export const reviewArticleDetailsNormalizeQuoteForHtmlMatch = (quote: string): string => {
  const trimmed = quote.trim()
  const withoutOuterEllipses = stripOuterEllipses(trimmed).trim()
  const withSplitCamelCase = withoutOuterEllipses.replace(/([a-z])([A-Z])/g, '$1 $2')
  return escapeAngleBracketsOutsideTags(escapeAmpersands(withSplitCamelCase))
}

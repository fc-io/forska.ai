const httpUrlPattern = /^https?:\/\//i
const doiResolverUrlPattern = /^https?:\/\/(?:www\.)?(?:dx\.)?doi\.org(?:[/?#:]|$)/i
const sourceUrlSeparatorPattern = /\s+|(?=https?:\/\/)/i

export const getArticleSourceUrl = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : ''

  return httpUrlPattern.test(text) && !doiResolverUrlPattern.test(text) ? text : null
}

export const getArticleSourceUrls = (value: unknown): string[] => {
  const text = typeof value === 'string' ? value : ''

  return text
    .split(sourceUrlSeparatorPattern)
    .map(getArticleSourceUrl)
    .filter((url): url is string => {
      return url !== null
    })
}

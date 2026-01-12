const sanitizeTitleForFilename = (title: string) => {
  const normalizedTitle = title.normalize('NFKD')
  const withoutDiacritics = normalizedTitle.replace(/[\u0300-\u036f]/g, '')
  const withDashes = withoutDiacritics.replace(/[^a-zA-Z0-9]+/g, '-')
  const trimmedDashes = withDashes.replace(/-+/g, '-').replace(/^-|-$/g, '')
  const windowsReservedPattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
  const reservedSafeTitle = windowsReservedPattern.test(trimmedDashes) ? `article-${trimmedDashes}` : trimmedDashes
  return reservedSafeTitle.length > 0 ? reservedSafeTitle : 'article'
}

export const getArticleDocumentTitle = (articleTitle?: string | null) => {
  const trimmedTitle = articleTitle?.trim() ?? ''
  const safeTitle = trimmedTitle.length > 0 ? sanitizeTitleForFilename(trimmedTitle) : ''
  return safeTitle.length > 0 ? `forska.ai ${safeTitle}` : 'forska.ai'
}

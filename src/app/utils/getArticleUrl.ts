export const getArticleUrl = (articleId: string | null): string => {
  const isArxiv = articleId && articleId.startsWith('oai:arXiv.org:')

  return isArxiv ? `https://www.arxiv.org/abs/${articleId.slice(14)}` : ''
}

type ArticleUrlStrategy = {isMatch: (articleId: string) => boolean; buildUrl: (articleId: string) => string}

const articleUrlStrategies: ArticleUrlStrategy[] = [
  {
    isMatch: (articleId) => {
      return articleId.startsWith('oai:arXiv.org:')
    },
    buildUrl: (articleId) => {
      return `https://www.arxiv.org/abs/${articleId.slice(14)}`
    },
  },
  {
    isMatch: (articleId) => {
      return articleId.startsWith('pmid:')
    },
    buildUrl: (articleId) => {
      return `https://pubmed.ncbi.nlm.nih.gov/${articleId.slice(5)}/`
    },
  },
]

export const getArticleUrl = (articleId: string | null): string => {
  const articleIdValue = articleId ?? ''
  const matchingStrategy = articleUrlStrategies.find((strategy) => {
    return strategy.isMatch(articleIdValue)
  })

  return matchingStrategy ? matchingStrategy.buildUrl(articleIdValue) : ''
}

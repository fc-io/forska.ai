import type {getNewestArticlesToJudge} from '../../components/main/projectsGrid/projectsGridGetNewestArticlesToJudge.ts'

const getSortedArticle = (data: any) => {
  const sortKey = (s: string) => {
    return s.replace(/_(quote|explanation)$/, '')
  }

  const sortPriority = (s: string) => {
    if (s.endsWith('_quote')) return 2
    if (s.endsWith('_explanation')) return 1
    return 0 // base comes first
  }

  const sort = (a: string, b: string) => {
    const keyA = sortKey(a)
    const keyB = sortKey(b)
    if (keyA < keyB) return -1
    if (keyA > keyB) return 1
    return sortPriority(a) - sortPriority(b)
  }

  const judgedAsKeys = Object.keys(data)
    .filter((key) => {
      return key.indexOf('article_judged_as') > -1
    })
    .sort(sort)

  return judgedAsKeys
}

const getSections = (judgedAsKeys: string[]): string => {
  return judgedAsKeys
    .map((key) => {
      if (key.indexOf('explanation') > -1) {
        return `## ${key}

Provide the reason why you judged it that way.

`
      }
      if (key.indexOf('quote') > -1) {
        return `## ${key}

Provide verbatim quotes (a maximum of 3 quotes) that highlight the reasoning behind your explanation. Only do this if the explanation tries to make case for why it judged that the topic was in the info.

`
      }
      const topicName =
        key
          .split('article_judged_as_')[1]
          ?.split('_')
          .filter((part) => {
            return part !== '_'
          })
          .join(' ') ?? 'unknown topic'
      return `## ${key}

Judge if the article is about "${topicName}". Can you find out anything about this from the provided title or summary.

`
    })
    .join('')
}

type ArticleType = Awaited<ReturnType<typeof getNewestArticlesToJudge>>[number]

export const judgeGetPrompt = (data: ArticleType): string => {
  const judgedAsKeys = getSortedArticle(data)
  const sections = getSections(judgedAsKeys)

  return `# id: ${data.articleId}

## article_title
${data.articleTitle}

## article_summary
${data.articleSummary}

${sections}`
}

import * as schema from '../../db/schema.ts'
import {getShortId} from '../../utils/getShortId.ts'

type PromptsType = (typeof schema.prompts.$inferSelect)[]

export const getBaseHeading = (prompt: PromptsType[number]): string => {
  return (prompt.promptHeading ?? `${prompt.order ?? 0}-${getShortId()}`) + `^^^${prompt.id}`
}

const getSections = (prompts: PromptsType): string => {
  return prompts.reduce((acc, prompt) => {
    const baseHeading = getBaseHeading(prompt)

    return `${acc}
### ${baseHeading}---question

question: ${prompt.originalText}

output_type: ${prompt.type}
`
  }, '')
}

type ArticleType = typeof schema.articles.$inferSelect

export const judgeGetPrompt = (article: ArticleType, prompts: PromptsType): string => {
  // const prompts = getSortedArticle(article)
  const sections = getSections(prompts)

  return `# id: ${article.articleId}

## article_title

${article.articleTitle}

## article_summary

${article.articleSummary}

## Below will be a number of questions from the user for you to answer about the title and summary provided above:
${sections}`
}

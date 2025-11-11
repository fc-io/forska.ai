import * as schema from '../../db/schema.ts'
import {getShortId} from '../../utils/getShortId.ts'

export type PromptForJudging = Array<{
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}>

export const getBaseHeading = (prompt: PromptForJudging[number]): string => {
  return (prompt.promptHeading ?? `${prompt.order ?? 0}-${getShortId()}`) + `^^^${prompt.id}`
}

const getSections = (prompts: PromptForJudging): string => {
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

export const judgeGetPrompt = (article: ArticleType, prompts: PromptForJudging): string => {
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

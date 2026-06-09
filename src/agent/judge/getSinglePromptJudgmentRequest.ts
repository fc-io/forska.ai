import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {type ContentSettings, judgeGetSinglePrompt, type SinglePromptType} from './judgeGetPrompt.ts'
import {getSinglePromptSystemPromptForArticle} from './judgePromptSelection.ts'

export const getSinglePromptJudgmentRequest = ({
  article,
  contentSettings,
  prompt,
  provider,
}: {
  article: ArticleRecord
  contentSettings: ContentSettings
  prompt: SinglePromptType
  provider?: string | null
}) => {
  const systemPrompt = getSinglePromptSystemPromptForArticle(article, provider)
  const userPrompt = judgeGetSinglePrompt(article, prompt, contentSettings, provider)
  const recordText = `${article.articleTitle}\n\n${article.articleSummary ?? ''}\n\n${article.fullText ?? ''}`

  return {recordText, systemPrompt, userPrompt}
}

export const getSinglePromptJudgmentPreviewText = ({
  systemPrompt,
  userPrompt,
}: {
  systemPrompt: string
  userPrompt: string
}) => {
  return `## System Prompt\n\n${systemPrompt}\n\n## User Prompt\n\n${userPrompt}`
}

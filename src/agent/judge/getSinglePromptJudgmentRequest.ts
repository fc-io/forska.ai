import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {type ContentSettings, judgeGetSinglePrompt, type SinglePromptType} from './judgeGetPrompt.ts'
import {getSinglePromptSystemPromptForArticle} from './judgePromptSelection.ts'
import type {SystemPromptVariant} from './systemPromptVariant.ts'

export const getSinglePromptJudgmentRequest = ({
  article,
  contentSettings,
  prompt,
  provider,
  systemPromptVariant,
}: {
  article: ArticleRecord
  contentSettings: ContentSettings
  prompt: SinglePromptType
  provider?: string | null
  systemPromptVariant?: SystemPromptVariant | null
}) => {
  const systemPrompt = getSinglePromptSystemPromptForArticle(article, provider, systemPromptVariant)
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

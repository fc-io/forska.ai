import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {
  type ContentSettings,
  getFullTextJudgingUserPrompt,
  judgeGetSinglePrompt,
  type SinglePromptType,
} from './judgeGetPrompt.ts'
import {getSinglePromptSystemPromptForArticle} from './judgePromptSelection.ts'
import type {SystemPromptVariant} from './systemPromptVariant.ts'

export const getJudgmentRecordText = (article: ArticleRecord, fullText: string | null): string => {
  return `${article.articleTitle}\n\n${article.articleSummary ?? ''}\n\n${fullText ?? ''}`
}

export const getSinglePromptJudgmentRequest = ({
  article,
  contentSettings,
  prompt,
  provider,
  renderedFullText = null,
  systemPromptVariant,
}: {
  article: ArticleRecord
  contentSettings: ContentSettings
  prompt: SinglePromptType
  provider?: string | null
  renderedFullText?: string | null
  systemPromptVariant?: SystemPromptVariant | null
}) => {
  const systemPrompt = getSinglePromptSystemPromptForArticle(article, provider, systemPromptVariant)
  const userPrompt =
    renderedFullText === null
      ? judgeGetSinglePrompt(article, prompt, contentSettings, provider)
      : getFullTextJudgingUserPrompt({article, contentSettings, prompt, renderedFullText})
  const recordText = getJudgmentRecordText(article, renderedFullText ?? article.fullText)

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

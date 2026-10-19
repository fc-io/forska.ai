import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getArticleMetadataSourceText} from './articleMetadataPrompt.ts'
import {
  type ContentSettings,
  getFullTextJudgingUserPrompt,
  getIsArticleMetadataQuotable,
  judgeGetSinglePrompt,
  type SinglePromptType,
} from './judgeGetPrompt.ts'
import {getSinglePromptSystemPromptForArticle} from './judgePromptSelection.ts'
import type {SystemPromptVariant} from './systemPromptVariant.ts'

const getJudgmentRecordMetadataText = (article: ArticleRecord, isArticleMetadataQuotable: boolean) => {
  return isArticleMetadataQuotable ? getArticleMetadataSourceText(article) : ''
}

export const getJudgmentRecordText = ({
  article,
  fullText,
  isArticleMetadataQuotable,
}: {
  article: ArticleRecord
  fullText: string | null
  isArticleMetadataQuotable: boolean
}): string => {
  const metadataText = getJudgmentRecordMetadataText(article, isArticleMetadataQuotable)
  const titleAndMetadata = metadataText === '' ? article.articleTitle : `${article.articleTitle}\n\n${metadataText}`

  return `${titleAndMetadata}\n\n${article.articleSummary ?? ''}\n\n${fullText ?? ''}`
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
  const recordText = getJudgmentRecordText({
    article,
    fullText: renderedFullText ?? article.fullText,
    isArticleMetadataQuotable: getIsArticleMetadataQuotable({
      systemPromptVariant,
      useMetadata: contentSettings.useMetadata,
    }),
  })

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

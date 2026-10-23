import {getArticleUrl} from '../../../../../app/utils/getArticleUrl.ts'
import {getArticleSourceMetadataValue} from '../../../../../utils/articleSourceMetadata.ts'
import {getLegacyNoImagesAwareFullTextStrategyLabel} from '../../../../../utils/legacyFullTextNoImagesLabel.ts'
import {getDateValue, getJsonValue} from '../../../../services/appQueryHelpers.ts'
import {escapeCSV} from '../../escapeCSV.ts'
import {getStringArray} from '../getStringArray.ts'
import type {ExportArticleRow, ExportContract, ExportJudgmentRow} from '../projectExportDownloadTypes.ts'

const formatArticleDate = (value: unknown): string => {
  const dateValue = getDateValue(value)

  return dateValue ? dateValue.toISOString() : ''
}

const getExportJournalTitle = (sourceMetadata: unknown) => {
  return getArticleSourceMetadataValue(sourceMetadata)?.journalTitle ?? ''
}

const getAnswerValue = (row: ExportJudgmentRow) => {
  const parsedAnswerArray = getJsonValue(row.answeredOriginalAsArray)

  return Array.isArray(parsedAnswerArray) && parsedAnswerArray.length > 0
    ? getStringArray(parsedAnswerArray).join('; ')
    : (row.answeredOriginal ?? '')
}

const getQuotesValue = (value: unknown) => {
  const quotesValue = getJsonValue(value)

  return Array.isArray(quotesValue)
    ? quotesValue
        .map((quote) => {
          return typeof quote === 'string' ? quote : JSON.stringify(quote)
        })
        .join('; ')
    : typeof quotesValue === 'string'
      ? quotesValue
      : quotesValue === null || quotesValue === undefined
        ? ''
        : JSON.stringify(quotesValue)
}

const getExportRowFullTextStrategyLabel = (input: {
  fullTextStrategyLabels: Map<string, string>
  judgments: Array<ExportJudgmentRow | undefined>
}) => {
  return [
    ...new Set(
      input.judgments.flatMap((judgment) => {
        return judgment?.fullTextStrategyId
          ? [
              getLegacyNoImagesAwareFullTextStrategyLabel({
                label: input.fullTextStrategyLabels.get(judgment.fullTextStrategyId) ?? judgment.fullTextStrategyId,
                useFulltextNoImages: judgment.useFulltextNoImages,
              }),
            ]
          : []
      }),
    ),
  ].join('; ')
}

export const buildExportCsvRows = (input: {
  articles: ExportArticleRow[]
  fullTextStrategyLabels: Map<string, string> | null
  judgments: ExportJudgmentRow[]
  orderedPromptIds: string[]
  promptOutput: NonNullable<ExportContract['promptOutput']>
  selectedMetadata: Record<string, boolean | undefined>
}) => {
  const judgmentsByArticleAndPrompt = new Map(
    input.judgments.map((judgment) => {
      return [`${judgment.articleId}:${judgment.promptId}`, judgment]
    }),
  )

  return input.articles.map((article) => {
    const sourceMetadata = getJsonValue(article.articleSourceMetadata)
    const originalData = getJsonValue(article.articleOriginalData)
    const articleAuthors = getJsonValue(article.articleAuthors)
    const row = [article.articleTitle || 'Untitled']

    if (input.selectedMetadata.includeArticleId) row.push(article.articleExternalId ?? article.articleId)
    if (input.selectedMetadata.includeArticleLink) {
      row.push(
        getArticleUrl({
          arxivId: article.arxivId,
          biorxivId: article.biorxivId,
          doi: article.doi,
          medrxivId: article.medrxivId,
          originalData,
          pubmedId: article.pubmedId,
          sourceMetadata,
          url: article.articleUrl,
        }),
      )
    }
    if (input.selectedMetadata.includeArticleAuthors) row.push(getStringArray(articleAuthors).join('; '))
    if (input.selectedMetadata.includeSummary) row.push(article.articleSummary || '')
    if (input.selectedMetadata.includeJournal) row.push(getExportJournalTitle(sourceMetadata))
    if (input.selectedMetadata.includeArticleCreatedAt) row.push(formatArticleDate(article.articleCreatedAt))
    if (input.selectedMetadata.includeArticleUpdatedAt) row.push(formatArticleDate(article.articleUpdatedAt))
    if (input.fullTextStrategyLabels) {
      row.push(
        getExportRowFullTextStrategyLabel({
          fullTextStrategyLabels: input.fullTextStrategyLabels,
          judgments: input.orderedPromptIds.map((promptId) => {
            return judgmentsByArticleAndPrompt.get(`${article.articleId}:${promptId}`)
          }),
        }),
      )
    }

    input.orderedPromptIds.forEach((promptId) => {
      const judgment = judgmentsByArticleAndPrompt.get(`${article.articleId}:${promptId}`)
      row.push(judgment ? getAnswerValue(judgment) : '')
      if (input.promptOutput.includeExplanation) row.push(judgment?.explanation ?? '')
      if (input.promptOutput.includeQuotes) row.push(judgment ? getQuotesValue(judgment.quotes) : '')
    })

    return row.map(escapeCSV).join(',')
  })
}

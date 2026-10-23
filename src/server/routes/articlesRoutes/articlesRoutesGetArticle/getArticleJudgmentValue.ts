import {getJudgmentFullTextExecution} from '../../../../agent/judge/judgmentFullTextExecution.ts'
import {getSystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import {getEffectiveFullTextStrategyId} from '../../../fullText/fullTextStrategy.ts'
import {getProviderModelMetadataOptions} from '../../../providers/providerModelMetadata.ts'
import {getDateValue, getJsonValue} from '../../../services/appQueryHelpers.ts'

export type ArticleJudgmentRow = {
  judgmentId: string
  judgmentCreatedAt: unknown
  judgmentUpdatedAt: unknown
  judgmentDeletedAt: unknown
  judgmentArticleId: string
  judgmentModelId: string
  judgmentPromptId: string
  judgmentProjectId: string | null
  judgmentUseTitle: boolean | null
  judgmentUseAbstract: boolean | null
  judgmentUseFulltext: boolean | null
  judgmentUseFulltextNoImages: boolean | null
  judgmentUseMetadata: boolean | null
  judgmentSystemPromptVariant: string | null
  judgmentFullTextStrategyId: string | null
  judgmentChunkingStrategy: string | null
  judgmentFullTextMode: string | null
  judgmentChunkCount: number | null
  judgmentChunkPlanHash: string | null
  judgmentIsAnswered: boolean | null
  judgmentAnsweredOriginal: string | null
  judgmentAnsweredOriginalAsArray: unknown
  judgmentConfidenceOriginal: number | null
  judgmentExplanation: string | null
  judgmentQuotes: unknown
  judgmentSnapshotProjectId: string | null
  judgmentSnapshotProjectModelName: string | null
  promptOriginalText: string
  promptHeading: string | null
  modelMetadataJson: unknown
  modelName: string | null
  modelProvider: string | null
  modelVersion: string | null
}

export const getArticleJudgmentValue = (row: ArticleJudgmentRow) => {
  const answeredOriginalAsArray = getJsonValue(row.judgmentAnsweredOriginalAsArray)
  const quotes = getJsonValue(row.judgmentQuotes)

  return {
    id: row.judgmentId,
    createdAt: getDateValue(row.judgmentCreatedAt),
    updatedAt: getDateValue(row.judgmentUpdatedAt),
    deletedAt: getDateValue(row.judgmentDeletedAt),
    articleId: row.judgmentArticleId,
    modelId: row.judgmentModelId,
    promptId: row.judgmentPromptId,
    projectId: row.judgmentProjectId,
    useTitle: row.judgmentUseTitle ?? true,
    useAbstract: row.judgmentUseAbstract ?? true,
    useFulltext: row.judgmentUseFulltext ?? false,
    useFulltextNoImages: row.judgmentUseFulltextNoImages ?? false,
    useMetadata: row.judgmentUseMetadata ?? false,
    systemPromptVariant: getSystemPromptVariant(row.judgmentSystemPromptVariant),
    fullTextStrategyId: getEffectiveFullTextStrategyId(row.judgmentFullTextStrategyId),
    chunkingStrategy: row.judgmentChunkingStrategy,
    ...getJudgmentFullTextExecution({
      chunkCount: row.judgmentChunkCount,
      chunkPlanHash: row.judgmentChunkPlanHash,
      fullTextMode: row.judgmentFullTextMode,
    }),
    isAnswered: row.judgmentIsAnswered ?? false,
    answeredOriginal: row.judgmentAnsweredOriginal,
    answeredOriginalAsArray: Array.isArray(answeredOriginalAsArray)
      ? answeredOriginalAsArray.filter((value): value is string => {
          return typeof value === 'string'
        })
      : null,
    confidenceOriginal: row.judgmentConfidenceOriginal ?? 50,
    explanation: row.judgmentExplanation,
    quotes: Array.isArray(quotes) ? quotes : [],
    snapshotProjectId: row.judgmentSnapshotProjectId,
    snapshotProjectModelName: row.judgmentSnapshotProjectModelName,
    prompt: {originalText: row.promptOriginalText, promptHeading: row.promptHeading},
    modelName: row.modelName,
    modelProvider: row.modelProvider,
    modelThinking: getProviderModelMetadataOptions(getJsonValue(row.modelMetadataJson)).thinking,
    modelVersion: row.modelVersion,
  }
}

import {getJudgmentFullTextExecution} from '../../../../agent/judge/judgmentFullTextExecution.ts'
import {getSystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {JudgmentChunkingStrategy, JudgmentRecord} from '../../../../db/schemaTypes.ts'
import {getEffectiveFullTextStrategyId} from '../../../fullText/fullTextStrategy.ts'
import {getDateValue, getJsonValue} from '../../../services/appQueryHelpers.ts'
import type {ProjectReviewDetailJudgmentRow} from './articleReviewDetailTypes.ts'

export const getProjectReviewDetailJudgmentValue = (row: ProjectReviewDetailJudgmentRow): JudgmentRecord => {
  const answeredOriginalAsArray = getJsonValue(row.judgmentAnsweredOriginalAsArray)
  const quotes = getJsonValue(row.judgmentQuotes)

  return {
    id: row.judgmentId,
    createdAt: getDateValue(row.judgmentCreatedAt) ?? new Date(0),
    updatedAt: getDateValue(row.judgmentUpdatedAt) ?? new Date(0),
    deletedAt: null,
    deleteGeneration: 0,
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
    chunkingStrategy: row.judgmentChunkingStrategy as JudgmentChunkingStrategy,
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
  }
}

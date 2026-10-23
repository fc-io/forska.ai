import {getSystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {JudgmentAssessmentRecord} from '../../../../db/schemaTypes.ts'
import {getEffectiveFullTextStrategyId} from '../../../fullText/fullTextStrategy.ts'
import {getDateValue} from '../../../services/appQueryHelpers.ts'
import type {ProjectPromptRow, ProjectReviewConfig, ProjectReviewDetailJudgmentRow} from './articleReviewDetailTypes.ts'
import {detailReaderPageSize} from './detailReaderPageSize.ts'
import {getPromptRowFromServingDetail} from './getPromptRowFromServingDetail.ts'
import {readAllReviewServingRows} from './readAllReviewServingRows.ts'
import {upsertPromptRow} from './upsertPromptRow.ts'

type ServingJudgmentDetailRow = {
  answered_original?: string | null
  answered_original_as_array?: unknown
  article_id?: string
  assessment_comment?: string | null
  assessment_created_at?: unknown
  assessment_id?: string | null
  assessment_is_correct?: boolean | null
  assessment_judgment_id?: string | null
  assessment_updated_at?: unknown
  detail_updated_at?: unknown
  explanation?: string | null
  human_comment?: string | null
  judgment_created_at?: unknown
  judgment_id?: string | null
  judgment_model_id?: string | null
  judgment_updated_at?: unknown
  placeholder_kind?: string | null
  prompt_criteria_disposition?: 'include' | 'exclude' | 'combined' | null
  prompt_heading?: string | null
  prompt_id?: string
  prompt_original_text?: string | null
  prompt_order?: number | null
  prompt_type?: string | null
  chunking_strategy?: string | null
  chunk_count?: number | null
  chunk_plan_hash?: string | null
  confidence_original?: number | null
  full_text_mode?: string | null
  is_answered?: boolean | null
  model_name?: string | null
  model_provider?: string | null
  model_thinking?: string | null
  model_version?: string | null
  quotes?: unknown
  snapshot_project_id?: string | null
  snapshot_project_model_name?: string | null
}

const getServingAssessmentValues = (row: ServingJudgmentDetailRow): JudgmentAssessmentRecord[] => {
  if (!row.assessment_id) {
    return []
  }

  return [
    {
      id: row.assessment_id,
      judgmentId: row.assessment_judgment_id ?? row.judgment_id ?? '',
      assessmentIsCorrect: row.assessment_is_correct ?? false,
      assessmentComment: row.assessment_comment ?? null,
      createdAt: getDateValue(row.assessment_created_at) ?? new Date(0),
      updatedAt: getDateValue(row.assessment_updated_at) ?? new Date(0),
    },
  ]
}

const getStringPayloadValue = (value: unknown, fallback: string) => {
  return typeof value === 'string' ? value : fallback
}

export const getProjectReviewDetailJudgmentRows = async (params: {
  projectId: string
  articleId: string
  reviewConfigHash: string | null
  projectReviewConfig: ProjectReviewConfig
}): Promise<{judgmentRows: ProjectReviewDetailJudgmentRow[]; promptRows: ProjectPromptRow[]} | null> => {
  const rows = await readAllReviewServingRows<ServingJudgmentDetailRow>({
    allowStale: true,
    articleId: params.articleId,
    contractKey: 'review.detail.judgments',
    limit: detailReaderPageSize,
    projectId: params.projectId,
    reviewConfigHash: params.reviewConfigHash,
    searchMode: 'none',
  })

  if (rows === null) {
    return null
  }

  const promptRowsById = rows.reduce((promptMap, row) => {
    return upsertPromptRow(promptMap, getPromptRowFromServingDetail(row))
  }, new Map<string, ProjectPromptRow>())

  const judgmentRows = rows
    .filter((row) => {
      return row.placeholder_kind === null || row.placeholder_kind === undefined
    })
    .map((row) => {
      const promptId = row.prompt_id ?? ''
      const prompt = getPromptRowFromServingDetail(row)

      return {
        judgmentId: row.judgment_id ?? `placeholder:${promptId}`,
        judgmentAssessments: getServingAssessmentValues(row),
        judgmentCreatedAt: row.judgment_created_at ?? null,
        judgmentUpdatedAt: row.judgment_updated_at ?? row.detail_updated_at ?? null,
        judgmentArticleId: row.article_id ?? params.articleId,
        judgmentModelId: getStringPayloadValue(row.judgment_model_id, ''),
        judgmentPromptId: promptId,
        judgmentProjectId: params.projectId,
        judgmentUseTitle: params.projectReviewConfig.useTitle,
        judgmentUseAbstract: params.projectReviewConfig.useAbstract,
        judgmentUseFulltext: params.projectReviewConfig.useFulltext,
        judgmentUseFulltextNoImages: params.projectReviewConfig.useFulltextNoImages,
        judgmentUseMetadata: params.projectReviewConfig.useMetadata ?? false,
        judgmentSystemPromptVariant: getSystemPromptVariant(params.projectReviewConfig.systemPromptVariant),
        judgmentFullTextStrategyId: getEffectiveFullTextStrategyId(params.projectReviewConfig.fullTextStrategyId),
        judgmentChunkingStrategy: row.chunking_strategy ?? null,
        judgmentFullTextMode: row.full_text_mode ?? null,
        judgmentChunkCount: row.chunk_count ?? null,
        judgmentChunkPlanHash: row.chunk_plan_hash ?? null,
        judgmentIsAnswered: row.is_answered ?? false,
        judgmentAnsweredOriginal: row.answered_original ?? null,
        judgmentAnsweredOriginalAsArray: row.answered_original_as_array ?? null,
        judgmentConfidenceOriginal: row.confidence_original ?? 50,
        judgmentExplanation: row.explanation ?? null,
        judgmentQuotes: row.quotes ?? [],
        judgmentSnapshotProjectId: row.snapshot_project_id ?? null,
        judgmentSnapshotProjectModelName: row.snapshot_project_model_name ?? null,
        promptOriginalText: prompt.originalText,
        promptHeading: prompt.promptHeading,
        modelMetadataJson: null,
        modelName: row.model_name ?? null,
        modelProvider: row.model_provider ?? null,
        modelThinking: row.model_thinking ?? null,
        modelVersion: row.model_version ?? null,
      }
    })

  return {judgmentRows, promptRows: [...promptRowsById.values()]}
}

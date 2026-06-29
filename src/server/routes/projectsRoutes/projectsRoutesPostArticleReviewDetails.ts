import {Elysia, t} from 'elysia'

import {getArticleUrl} from '../../../app/utils/getArticleUrl.ts'
import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import type {
  JudgmentAssessmentRecord,
  JudgmentChunkingStrategy,
  JudgmentRecord,
  PromptRecord,
} from '../../../db/schemaTypes.ts'
import {getArticleSourceMetadataValue} from '../../../utils/articleSourceMetadata.ts'
import {getProviderModelMetadataOptions} from '../../providers/providerModelMetadata.ts'
import {readReviewServingRows, type ReviewServingReaderResult} from '../../reviewServing/reviewServingReader.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../services/projectVisibleJudgmentRule.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {getSystemActor} from '../../utils/getSystemActor.ts'
import {
  deriveStrictSummaryAnswer,
  getNormalizedSummaryAnswer,
  normalizeSummaryAnswerValue,
} from '../../utils/judgmentAnswers.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

type JudgmentWithPromptAndAssessments = JudgmentRecord & {
  prompt: Pick<PromptRecord, 'originalText' | 'promptHeading'>
  assessments: Array<JudgmentAssessmentRecord>
  modelName?: string | null
  modelProvider?: string | null
  modelThinking?: string | null
  modelVersion?: string | null
}

type PlaceholderJudgment = {
  id: string
  promptId: string
  answeredOriginal: 'not answered'
  confidenceOriginal: null
  explanation: null
  quotes: JudgmentRecord['quotes']
  prompt: Pick<PromptRecord, 'originalText' | 'promptHeading'>
  assessments: Array<JudgmentAssessmentRecord>
  createdAt: null
  modelName?: string | null
  modelProvider?: string | null
  modelThinking?: string | null
  modelVersion?: string | null
}

type ReviewJudgment = JudgmentWithPromptAndAssessments | PlaceholderJudgment

type ArticleJudgmentRow = ProjectReviewDetailJudgmentRow & {judgmentDeletedAt: unknown}

type ProjectReviewConfig = {
  humanJudgmentMode?: 'prompt' | 'summary'
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type ProjectReviewDetailJudgmentRow = {
  judgmentAssessments: unknown
  judgmentId: string
  judgmentCreatedAt: unknown
  judgmentUpdatedAt: unknown
  judgmentArticleId: string
  judgmentModelId: string
  judgmentPromptId: string
  judgmentProjectId: string | null
  judgmentUseTitle: boolean | null
  judgmentUseAbstract: boolean | null
  judgmentUseFulltext: boolean | null
  judgmentUseFulltextNoImages: boolean | null
  judgmentChunkingStrategy: string | null
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
  modelThinking: string | null
  modelVersion: string | null
}

type ServingJudgmentDetailRow = {
  answered_original?: string | null
  answered_original_as_array?: unknown
  article_id?: string
  detail_updated_at?: unknown
  judgment_id?: string | null
  judgment_payload_json?: unknown
  model_id?: string | null
  placeholder_kind?: string | null
  prompt_id?: string
  prompt_order?: number | null
}

type ReviewServingDetailRowsRequest = Parameters<typeof readReviewServingRows>[0]

type ServingHumanJudgmentDetailRow = {
  answered_original?: string | null
  article_id?: string
  detail_updated_at?: unknown
  judgment_id?: string | null
  judgment_payload_json?: unknown
  payload_kind?: string
  prompt_id?: string
  prompt_order?: number | null
}

type ServingArticleDetailRow = {
  article_created_at?: unknown
  article_external_id?: string | null
  article_id?: string
  article_title?: string | null
  article_updated_at?: unknown
  arxiv_id?: string | null
  biorxiv_id?: string | null
  doi?: string | null
  full_text_conversion_status?: string | null
  full_text_fetched_at?: unknown
  full_text_pdf?: string | null
  journal_title?: string | null
  medrxiv_id?: string | null
  pmid?: string | null
  publication_year?: number | null
  source_metadata?: unknown
  url?: string | null
}

type ServingArticlePayloadRow = {
  abstract_text?: string | null
  article_created_at?: unknown
  article_id?: string
  full_text_preview?: string | null
  source_metadata?: unknown
}

type ArticleFullTextRow = {
  fullText: string | null
  fullTextCharCount: number | null
  fullTextHtml: string | null
  fullTextOriginalFormat: string | null
  fullTextSource: string | null
  importRoute: string | null
}

type ProjectPromptRow = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
  enabled: boolean | null
  criteriaDisposition: 'include' | 'exclude' | 'combined' | null
  originProjectId: string | null
}

type PromptDisplayPayload = {
  criteriaDisposition?: 'include' | 'exclude' | 'combined' | null
  id?: string | null
  order?: number | null
  originalText?: string | null
  promptHeading?: string | null
  type?: string | null
}

type ModelDisplayPayload = {
  id?: string | null
  name?: string | null
  provider?: string | null
  thinking?: string | null
  version?: string | null
}

type ReviewJudgmentDetail = {
  judgment: JudgmentRecord
  prompt: Pick<PromptRecord, 'originalText' | 'promptHeading'>
  modelName: string | null
  modelProvider: string | null
  modelThinking: string | null
  modelVersion: string | null
}

type AssessmentRow = {
  id: string
  judgmentId: string
  assessmentIsCorrect: boolean | null
  assessmentComment: string | null
  createdAt: unknown
  updatedAt: unknown
}

type CovidenceRelatedRecord = {
  articleExternalId: string | null
  articleTitle: string
  articleUrl: string | null
  covidenceIds: string[]
  hasDuplicateStudyRecords: boolean
  hasStudyDecisionConflict: boolean
  id: string
  isCurrentRecord: boolean
  isSeededHumanJudgmentAnswered: boolean
  referenceIds: string[]
  seededHumanJudgmentAnswer: string | null
  stageMembership: Record<string, boolean>
}

const getJsonObjectValue = (value: unknown): Record<string, unknown> => {
  const parsed = getJsonValue(value)

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

const getServingDateValue = (value: unknown) => {
  return getDateValue(value) ?? null
}

const getStringPayloadValue = (value: unknown, fallback: string) => {
  return typeof value === 'string' ? value : fallback
}

const getPromptPayload = (payload: Record<string, unknown>, promptId: string): ProjectPromptRow => {
  const prompt = getJsonObjectValue(payload.prompt) as PromptDisplayPayload

  return {
    criteriaDisposition: prompt.criteriaDisposition ?? null,
    enabled: true,
    id: prompt.id ?? promptId,
    order: prompt.order ?? null,
    originalText: prompt.originalText ?? '',
    originProjectId: null,
    promptHeading: prompt.promptHeading ?? null,
    type: prompt.type ?? null,
  }
}

const getModelPayload = (payload: Record<string, unknown>): ModelDisplayPayload => {
  return getJsonObjectValue(payload.model) as ModelDisplayPayload
}

const upsertPromptRow = (promptRowsById: Map<string, ProjectPromptRow>, promptRow: ProjectPromptRow) => {
  return promptRow.id.length === 0 || promptRow.id === 'summary'
    ? promptRowsById
    : promptRowsById.set(promptRow.id, promptRow)
}

const detailReaderPageSize = 512

const readAllReviewServingRows = async <T>(
  request: ReviewServingDetailRowsRequest,
  cursor: string | null = null,
  previousRows: T[] = [],
): Promise<T[] | null> => {
  const result = await readReviewServingRows<T>({...request, cursor, limit: detailReaderPageSize})

  if (result.status === 'rejected') {
    return null
  }

  const rows = [...previousRows, ...result.rows]
  const lastRow = result.rows[result.rows.length - 1]
  const nextCursor =
    result.rows.length === detailReaderPageSize && lastRow
      ? result.getCursorForRow(lastRow as Record<string, unknown>)
      : null

  return nextCursor ? readAllReviewServingRows(request, nextCursor, rows) : rows
}

const getPromptValue = (row: {promptOriginalText: string; promptHeading: string | null}) => {
  return {originalText: row.promptOriginalText, promptHeading: row.promptHeading}
}

const getProjectReviewDetailJudgmentRows = async (params: {
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
    const promptId = row.prompt_id ?? ''
    const payload = getJsonObjectValue(row.judgment_payload_json)
    return upsertPromptRow(promptMap, getPromptPayload(payload, promptId))
  }, new Map<string, ProjectPromptRow>())

  const judgmentRows = rows
    .filter((row) => {
      return row.placeholder_kind === null || row.placeholder_kind === undefined
    })
    .map((row) => {
      const payload = getJsonObjectValue(row.judgment_payload_json)
      const promptId = row.prompt_id ?? ''
      const modelId = row.model_id ?? ''
      const prompt = getPromptPayload(payload, promptId)
      const model = getModelPayload(payload)

      return {
        judgmentId: row.judgment_id ?? getStringPayloadValue(payload.id, `placeholder:${promptId}`),
        judgmentAssessments: payload.assessments ?? [],
        judgmentCreatedAt: payload.createdAt ?? null,
        judgmentUpdatedAt: payload.updatedAt ?? row.detail_updated_at ?? null,
        judgmentArticleId: row.article_id ?? params.articleId,
        judgmentModelId: modelId,
        judgmentPromptId: promptId,
        judgmentProjectId: params.projectId,
        judgmentUseTitle: params.projectReviewConfig.useTitle,
        judgmentUseAbstract: params.projectReviewConfig.useAbstract,
        judgmentUseFulltext: params.projectReviewConfig.useFulltext,
        judgmentUseFulltextNoImages: params.projectReviewConfig.useFulltextNoImages,
        judgmentChunkingStrategy: (payload.chunkingStrategy as string | null | undefined) ?? null,
        judgmentIsAnswered: (payload.isAnswered as boolean | null | undefined) ?? false,
        judgmentAnsweredOriginal: row.answered_original ?? null,
        judgmentAnsweredOriginalAsArray: row.answered_original_as_array ?? null,
        judgmentConfidenceOriginal: (payload.confidenceOriginal as number | null | undefined) ?? 50,
        judgmentExplanation: (payload.explanation as string | null | undefined) ?? null,
        judgmentQuotes: payload.quotes ?? [],
        judgmentSnapshotProjectId: (payload.snapshotProjectId as string | null | undefined) ?? null,
        judgmentSnapshotProjectModelName: (payload.snapshotProjectModelName as string | null | undefined) ?? null,
        promptOriginalText: prompt.originalText,
        promptHeading: prompt.promptHeading,
        modelMetadataJson: null,
        modelName: model.name ?? null,
        modelProvider: model.provider ?? null,
        modelThinking: model.thinking ?? null,
        modelVersion: model.version ?? null,
      }
    })

  return {judgmentRows, promptRows: [...promptRowsById.values()]}
}

const getProjectReviewDetailHumanRows = async (params: {
  articleId: string
  projectId: string
  reviewConfigHash: string | null
}) => {
  const rows = await readAllReviewServingRows<ServingHumanJudgmentDetailRow>({
    allowStale: true,
    articleId: params.articleId,
    contractKey: 'review.detail.humanJudgments',
    limit: detailReaderPageSize,
    projectId: params.projectId,
    reviewConfigHash: params.reviewConfigHash,
    searchMode: 'none',
  })

  if (rows === null) {
    return []
  }

  return rows
    .map((row) => {
      const payload = getJsonObjectValue(row.judgment_payload_json)
      const promptId = row.prompt_id ?? ''
      const prompt = getPromptPayload(payload, promptId)

      return {
        judgmentId: row.judgment_id ?? getStringPayloadValue(payload.id, ''),
        promptId,
        answer: row.answered_original ?? (payload.answer as string | null | undefined) ?? null,
        comment: (payload.comment as string | null | undefined) ?? null,
        promptOriginalText: prompt.originalText || 'Overall human screening decision',
        promptOrder: promptId === 'summary' ? 0 : (row.prompt_order ?? prompt.order ?? null),
        updatedAt: getServingDateValue(payload.updatedAt ?? row.detail_updated_at),
      }
    })
    .filter((row) => {
      return row.judgmentId.length > 0 && row.answer !== null && row.answer !== ''
    })
}

const getArticleJudgmentRows = async (params: {
  articleId: string
  projectId: string
}): Promise<ArticleJudgmentRow[]> => {
  return getAppDatabaseService().queryJson<ArticleJudgmentRow>(`
    WITH project_scope_article AS (
      SELECT pir.project_id, air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${getSqlLiteral(params.projectId)}
        AND air.article_id = ${getSqlLiteral(params.articleId)}
      UNION
      SELECT pa.project_id, pa.article_id
      FROM app.project_article pa
      WHERE pa.project_id = ${getSqlLiteral(params.projectId)}
        AND pa.article_id = ${getSqlLiteral(params.articleId)}
    )
    SELECT
      j.id AS judgmentId,
      [] AS judgmentAssessments,
      j.created_at AS judgmentCreatedAt,
      j.updated_at AS judgmentUpdatedAt,
      j.deleted_at AS judgmentDeletedAt,
      j.article_id AS judgmentArticleId,
      j.model_id AS judgmentModelId,
      j.prompt_id AS judgmentPromptId,
      j.project_id AS judgmentProjectId,
      j.use_title AS judgmentUseTitle,
      j.use_abstract AS judgmentUseAbstract,
      j.use_fulltext AS judgmentUseFulltext,
      j.use_fulltext_no_images AS judgmentUseFulltextNoImages,
      j.chunking_strategy AS judgmentChunkingStrategy,
      j.is_answered AS judgmentIsAnswered,
      j.answered_original AS judgmentAnsweredOriginal,
      TO_JSON(j.answered_original_as_array) AS judgmentAnsweredOriginalAsArray,
      j.confidence_original AS judgmentConfidenceOriginal,
      j.explanation AS judgmentExplanation,
      TO_JSON(j.quotes) AS judgmentQuotes,
      j.snapshot_project_id AS judgmentSnapshotProjectId,
      j.snapshot_project_model_name AS judgmentSnapshotProjectModelName,
      p.original_text AS promptOriginalText,
      p.prompt_heading AS promptHeading,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
      pc.provider_kind AS modelProvider,
      NULL AS modelThinking,
      m.variant AS modelVersion
    FROM app.judgment j
    INNER JOIN project_scope_article scope_article ON scope_article.article_id = j.article_id
    INNER JOIN app.project project ON project.id = scope_article.project_id
    INNER JOIN app.project_prompt project_prompt ON project_prompt.prompt_id = j.prompt_id
    INNER JOIN app.prompt p ON j.prompt_id = p.id
    LEFT JOIN app.model m ON j.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE project.id = ${getSqlLiteral(params.projectId)}
      AND project.archived = FALSE
      AND ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'j',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
      AND j.deleted_at IS NULL
    ORDER BY j.created_at DESC NULLS LAST, j.id ASC
  `)
}

const getProjectReviewDetailJudgmentValue = (row: ProjectReviewDetailJudgmentRow): JudgmentRecord => {
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
    chunkingStrategy: row.judgmentChunkingStrategy as JudgmentChunkingStrategy,
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

const getJudgmentValue = (row: ArticleJudgmentRow): JudgmentRecord => {
  return {...getProjectReviewDetailJudgmentValue(row), deletedAt: getDateValue(row.judgmentDeletedAt)}
}

const getModelThinkingValue = (row: {modelMetadataJson: unknown}) => {
  return getProviderModelMetadataOptions(getJsonValue(row.modelMetadataJson)).thinking ?? null
}

const getAssessmentValue = (row: {
  id: string
  judgmentId: string
  assessmentIsCorrect: boolean | null
  assessmentComment: string | null
  createdAt: unknown
  updatedAt: unknown
}): JudgmentAssessmentRecord => {
  return {
    id: row.id,
    judgmentId: row.judgmentId,
    assessmentIsCorrect: row.assessmentIsCorrect ?? false,
    assessmentComment: row.assessmentComment,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
  }
}

const getCovidenceRelatedRecords = async (params: {
  article: ArticleRecord
  projectId: string
}): Promise<CovidenceRelatedRecord[]> => {
  const article = params.article
  const covidence = getArticleSourceMetadataValue(article.sourceMetadata)?.covidence

  if (!covidence?.studyKey) {
    return []
  }

  const rows = await getAppDatabaseService().queryJson<{
    articleExternalId: string | null
    articleTitle: string
    arxivId: string | null
    biorxivId: string | null
    doi: string | null
    id: string
    isCurrentRecord: boolean
    medrxivId: string | null
    pubmedId: string | null
    rawPayload: unknown
    sourceMetadata: unknown
    url: string | null
  }>(`
    WITH project_route AS (
      SELECT import_route_id
      FROM app.project_import_route
      WHERE project_id = ${getSqlLiteral(params.projectId)}
    ),
    source_record_related_record AS (
      SELECT
        source_record.id AS id,
        source_record.external_article_id AS articleExternalId,
        article.article_title AS articleTitle,
        article.arxiv_id AS arxivId,
        article.biorxiv_id AS biorxivId,
        article.doi AS doi,
        article.medrxiv_id AS medrxivId,
        article.pubmed_id AS pubmedId,
        COALESCE(json_extract_string(source_record.raw_payload, '$.covidence.citation.url'), article.url) AS url,
        source_record.article_id = ${getSqlLiteral(article.id)} AS isCurrentRecord,
        source_record.raw_payload AS rawPayload,
        source_record.import_metadata AS sourceMetadata
      FROM app.article_import_route_source_record source_record
      INNER JOIN project_route ON project_route.import_route_id = source_record.import_route_id
      INNER JOIN app.article article ON article.id = source_record.article_id
      WHERE source_record.quarantined_at IS NULL
        AND json_extract_string(source_record.import_metadata, '$.covidence.studyKey') = ${getSqlLiteral(covidence.studyKey)}
    ),
    legacy_related_record AS (
      SELECT
        article.id AS id,
        article.article_id AS articleExternalId,
        article.article_title AS articleTitle,
        article.arxiv_id AS arxivId,
        article.biorxiv_id AS biorxivId,
        article.doi AS doi,
        article.medrxiv_id AS medrxivId,
        article.pubmed_id AS pubmedId,
        article.url AS url,
        article.id = ${getSqlLiteral(article.id)} AS isCurrentRecord,
        article.original_data AS rawPayload,
        article.source_metadata AS sourceMetadata
      FROM app.article article
      WHERE article.import_route = ${getSqlLiteral(article.importRoute)}
        AND json_extract_string(article.source_metadata, '$.covidence.studyKey') = ${getSqlLiteral(covidence.studyKey)}
    )
    SELECT * FROM source_record_related_record
    UNION ALL
    SELECT * FROM legacy_related_record
    WHERE NOT EXISTS (
      SELECT 1
      FROM source_record_related_record source_record
      WHERE source_record.id = legacy_related_record.id
    )
    ORDER BY articleTitle ASC, articleExternalId ASC NULLS LAST, id ASC
  `)

  return rows.map((row) => {
    const sourceMetadata = getJsonValue(row.sourceMetadata)
    const relatedCovidence = getArticleSourceMetadataValue(sourceMetadata)?.covidence

    return {
      articleExternalId: row.articleExternalId,
      articleTitle: row.articleTitle,
      articleUrl:
        getArticleUrl({
          arxivId: row.arxivId,
          biorxivId: row.biorxivId,
          doi: row.doi,
          medrxivId: row.medrxivId,
          originalData: getJsonValue(row.rawPayload),
          pubmedId: row.pubmedId,
          sourceMetadata,
          url: row.url,
        }) || null,
      covidenceIds: relatedCovidence?.covidenceIds ?? [],
      hasDuplicateStudyRecords: relatedCovidence?.hasDuplicateStudyRecords ?? false,
      hasStudyDecisionConflict: relatedCovidence?.hasStudyDecisionConflict ?? false,
      id: row.id,
      isCurrentRecord: row.isCurrentRecord || row.id === article.id,
      isSeededHumanJudgmentAnswered: relatedCovidence?.isSeededHumanJudgmentAnswered ?? false,
      referenceIds: relatedCovidence?.referenceIds ?? [],
      seededHumanJudgmentAnswer: relatedCovidence?.seededHumanJudgmentAnswer ?? null,
      stageMembership: relatedCovidence?.stageMembership ?? {},
    }
  })
}

const getUnavailableReviewDetail = (input: {
  articleId: string
  diagnostics?: ReviewServingReaderResult<ServingArticleDetailRow>['diagnostics'] | null
  reason: string
}) => {
  return {
    article: null,
    allJudgments: [],
    covidenceRelatedRecords: [],
    diagnostics: input.diagnostics ?? null,
    humanAnswersByPrompt: undefined,
    humanAssessmentsByUser: [],
    humanJudgmentMode: undefined,
    humanSummaryAnswer: null,
    judgments: [],
    llmSummaryAnswer: null,
    martFreshness: null,
    projectsById: {},
    prompts: [],
    reason: input.reason,
    requestedArticleId: input.articleId,
    status: 'unavailable' as const,
  }
}

const readProjectReviewArticleDetail = async (input: {
  articleId: string
  projectId: string
  reviewConfigHash: string | null
}) => {
  return readReviewServingRows<ServingArticleDetailRow>({
    articleId: input.articleId,
    contractKey: 'review.detail.row',
    estimatedResultRows: 1,
    limit: 1,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
    searchMode: 'none',
  })
}

const readProjectReviewArticlePayload = async (input: {
  articleId: string
  projectId: string
  reviewConfigHash: string | null
}) => {
  return readReviewServingRows<ServingArticlePayloadRow>({
    articleId: input.articleId,
    contractKey: 'review.detail.payload',
    estimatedResultRows: 1,
    limit: 1,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
    searchMode: 'none',
  })
}

const getArticleRecordFromServing = (input: {
  articleId: string
  detail: ServingArticleDetailRow
  fullText: ArticleFullTextRow | null
  payload: ServingArticlePayloadRow | null
}): ArticleRecord => {
  const sourceMetadata = getJsonValue(input.payload?.source_metadata ?? input.detail.source_metadata)

  return {
    articleAuthors: null,
    articleCreatedAt: getDateValue(input.detail.article_created_at ?? input.payload?.article_created_at),
    articleId: input.detail.article_external_id ?? null,
    articleSummary: input.payload?.abstract_text ?? null,
    articleTitle: input.detail.article_title ?? '',
    articleUpdatedAt: getDateValue(input.detail.article_updated_at),
    articleVersion: null,
    arxivId: input.detail.arxiv_id ?? null,
    biorxivId: input.detail.biorxiv_id ?? null,
    contentHash: null,
    createdAt: new Date(0),
    doi: input.detail.doi ?? null,
    fullText: input.fullText?.fullText ?? input.payload?.full_text_preview ?? null,
    fullTextAssets: null,
    fullTextCharCount: input.fullText?.fullTextCharCount ?? input.payload?.full_text_preview?.length ?? null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: input.detail.full_text_conversion_status ?? null,
    fullTextFetchedAt: getDateValue(input.detail.full_text_fetched_at),
    fullTextHtml: input.fullText?.fullTextHtml ?? null,
    fullTextOriginalFormat: input.fullText?.fullTextOriginalFormat ?? null,
    fullTextPDF: input.detail.full_text_pdf ?? null,
    fullTextSource: input.fullText?.fullTextSource ?? null,
    id: input.detail.article_id ?? input.articleId,
    importRoute: input.fullText?.importRoute ?? null,
    medrxivId: input.detail.medrxiv_id ?? null,
    originalData: null,
    publicationStatus: null,
    pubmedId: input.detail.pmid ?? null,
    sourceMetadata,
    updatedAt: new Date(0),
    url: input.detail.url ?? null,
  }
}

export const projectsRoutesPostArticleReviewDetails = new Elysia().post(
  '/api/projectsreview',
  async ({body}) => {
    try {
      const {projectId, articleId} = body

      await assertProjectIsActive(projectId)

      const projectReviewConfigPromise: Promise<ProjectReviewConfig | null> =
        getAppQueryService().getProjectReviewConfig(projectId)
      const reviewConfigHashPromise = getCurrentReviewConfigHash(projectId)
      const projectReviewConfig = await projectReviewConfigPromise
      const reviewConfigHash = await reviewConfigHashPromise

      if (!projectReviewConfig) {
        throw new Error('Project not found')
      }

      const [articleDetailResult, articlePayloadResult] = await Promise.all([
        readProjectReviewArticleDetail({articleId, projectId, reviewConfigHash}),
        readProjectReviewArticlePayload({articleId, projectId, reviewConfigHash}),
      ])

      if (articleDetailResult.status === 'rejected') {
        return getUnavailableReviewDetail({
          articleId,
          diagnostics: articleDetailResult.diagnostics,
          reason: articleDetailResult.reason,
        })
      }

      const [articleDetail] = articleDetailResult.rows

      if (!articleDetail) {
        return getUnavailableReviewDetail({articleId, reason: 'detail row unavailable'})
      }

      const [articlePayload, articleFullTextRows, allArticleJudgments] = await Promise.all([
        Promise.resolve(articlePayloadResult.status === 'accepted' ? (articlePayloadResult.rows[0] ?? null) : null),
        getAppDatabaseService().queryJson<ArticleFullTextRow>(`
          SELECT
            full_text AS fullText,
            full_text_char_count AS fullTextCharCount,
            full_text_html AS fullTextHtml,
            full_text_original_format AS fullTextOriginalFormat,
            full_text_source AS fullTextSource,
            import_route AS importRoute
          FROM app.article
          WHERE id = ${getSqlLiteral(articleId)}
          LIMIT 1
        `),
        getArticleJudgmentRows({articleId, projectId}),
      ])
      const article = getArticleRecordFromServing({
        articleId,
        detail: articleDetail,
        fullText: articleFullTextRows[0] ?? null,
        payload: articlePayload,
      })
      const covidenceRelatedRecords = await getCovidenceRelatedRecords({article, projectId})

      const projectReviewDetailJudgmentResult = await getProjectReviewDetailJudgmentRows({
        projectId,
        articleId,
        projectReviewConfig,
        reviewConfigHash,
      })

      if (projectReviewDetailJudgmentResult === null) {
        return getUnavailableReviewDetail({articleId, reason: 'detail judgments unavailable'})
      }

      const projectReviewDetailJudgmentRows = projectReviewDetailJudgmentResult.judgmentRows
      const projectPromptRows = projectReviewDetailJudgmentResult.promptRows.sort((a, b) => {
        return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
      })

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })
      const enabledPromptRows = projectPromptRows.filter((p) => {
        return p.enabled === true
      })
      const summaryCriteria = enabledPromptRows.map((row) => {
        return {promptId: row.id, criteriaDisposition: row.criteriaDisposition}
      })
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = p.order ?? idx
          acc[p.id] = ord
          return acc
        },
        {} as Record<string, number>,
      )
      const projectReviewDetailJudgmentDetails: ReviewJudgmentDetail[] = projectReviewDetailJudgmentRows.map((row) => {
        return {
          judgment: getProjectReviewDetailJudgmentValue(row),
          prompt: getPromptValue(row),
          modelName: row.modelName,
          modelProvider: row.modelProvider,
          modelThinking: row.modelThinking,
          modelVersion: row.modelVersion,
        }
      })
      const enabledPromptIdSet = new Set(
        enabledPromptRows.map((row) => {
          return row.id
        }),
      )
      const projectReviewDetailJudgmentIdSet = new Set<string>(
        projectReviewDetailJudgmentDetails.map((detail) => {
          return detail.judgment.id
        }),
      )
      const projectReviewDetailPromptIdSet = new Set<string>(
        projectReviewDetailJudgmentDetails.map((detail) => {
          return detail.judgment.promptId
        }),
      )
      const fallbackAppJudgmentDetails: ReviewJudgmentDetail[] = allArticleJudgments
        .filter((row) => {
          return (
            enabledPromptIdSet.has(row.judgmentPromptId)
            && !projectReviewDetailJudgmentIdSet.has(row.judgmentId)
            && !projectReviewDetailPromptIdSet.has(row.judgmentPromptId)
          )
        })
        .map((row) => {
          return {
            judgment: getJudgmentValue(row),
            prompt: getPromptValue(row),
            modelName: row.modelName,
            modelProvider: row.modelProvider,
            modelThinking: getModelThinkingValue(row),
            modelVersion: row.modelVersion,
          }
        })
      const articleJudgments: ReviewJudgmentDetail[] = [
        ...projectReviewDetailJudgmentDetails,
        ...fallbackAppJudgmentDetails,
      ]
      const latestArticleJudgmentsByPrompt = articleJudgments.reduce<Map<string, ReviewJudgmentDetail>>(
        (judgmentMap, row) => {
          const existing = judgmentMap.get(row.judgment.promptId)

          return !existing || row.judgment.createdAt >= existing.judgment.createdAt
            ? judgmentMap.set(row.judgment.promptId, row)
            : judgmentMap
        },
        new Map<string, ReviewJudgmentDetail>(),
      )
      const llmSummaryAnswer =
        projectReviewConfig.humanJudgmentMode === 'summary'
          ? deriveStrictSummaryAnswer(
              summaryCriteria,
              Array.from(latestArticleJudgmentsByPrompt.values()).reduce<Record<string, 'yes' | 'no' | 'maybe' | null>>(
                (answerMap, row) => {
                  return {...answerMap, [row.judgment.promptId]: getNormalizedSummaryAnswer(row.judgment)}
                },
                {},
              ),
            )
          : null

      const normalizedAssessments = projectReviewDetailJudgmentRows.flatMap((row) => {
        const assessments = Array.isArray(row.judgmentAssessments) ? row.judgmentAssessments : []
        return assessments
          .filter((assessment): assessment is AssessmentRow => {
            return typeof assessment === 'object' && assessment !== null && 'id' in assessment
          })
          .map((assessment) => {
            return getAssessmentValue(assessment)
          })
      })

      const assessmentsByJudgment = normalizedAssessments.reduce<Record<string, Array<JudgmentAssessmentRecord>>>(
        (acc, assessment) => {
          const judgmentAssessments = acc[assessment.judgmentId] ?? []
          return {...acc, [assessment.judgmentId]: [...judgmentAssessments, assessment]}
        },
        {},
      )

      const judgmentsWithDetails: ReviewJudgment[] = articleJudgments.map((row) => {
        const judgmentAssessments = assessmentsByJudgment[row.judgment.id] ?? []
        return {
          ...row.judgment,
          prompt: row.prompt,
          assessments: judgmentAssessments,
          modelName: row.modelName,
          modelProvider: row.modelProvider,
          modelThinking: row.modelThinking,
          modelVersion: row.modelVersion,
        }
      })

      const presentPromptIds = new Set(
        articleJudgments.map((judgment) => {
          return judgment.judgment.promptId
        }),
      )

      const placeholders: PlaceholderJudgment[] = enabledPromptRows
        .filter((p) => {
          return !presentPromptIds.has(p.id)
        })
        .map((p) => {
          return {
            id: `placeholder:${p.id}`,
            promptId: p.id,
            answeredOriginal: 'not answered',
            confidenceOriginal: null,
            explanation: null,
            quotes: [] as JudgmentRecord['quotes'],
            prompt: {originalText: p.originalText, promptHeading: p.promptHeading},
            assessments: [] as Array<JudgmentAssessmentRecord>,
            createdAt: null,
          }
        })

      const judgmentsWithPlaceholders: ReviewJudgment[] = [...judgmentsWithDetails, ...placeholders]

      judgmentsWithPlaceholders.sort((a, b) => {
        const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
        const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
        if (ao !== bo) return ao - bo
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return bt - at
      })

      const judgmentIdSet = new Set(
        articleJudgments.map((row) => {
          return row.judgment.id
        }),
      )
      const allJudgments: ReviewJudgment[] = allArticleJudgments
        .filter((row) => {
          return !judgmentIdSet.has(row.judgmentId)
        })
        .map((row) => {
          return {
            ...getJudgmentValue(row),
            prompt: getPromptValue(row),
            assessments: [],
            modelName: row.modelName,
            modelProvider: row.modelProvider,
            modelThinking: getModelThinkingValue(row),
            modelVersion: row.modelVersion,
          }
        })
      const snapshotProjectIds = Array.from(
        new Set(
          allJudgments
            .map((judgment) => {
              return 'snapshotProjectId' in judgment ? judgment.snapshotProjectId : null
            })
            .filter((id): id is string => {
              return Boolean(id)
            }),
        ),
      )
      const projectNameRows =
        snapshotProjectIds.length > 0
          ? await getAppDatabaseService().queryJson<{id: string; name: string}>(`
              SELECT id, name
              FROM app.project
              WHERE id IN (${getQuotedStringList(snapshotProjectIds).join(', ')})
            `)
          : []
      const projectsById = projectNameRows.reduce<Record<string, {name: string}>>((acc, row) => {
        return {...acc, [row.id]: {name: row.name}}
      }, {})

      const systemActor = getSystemActor()

      const humanRows = await getProjectReviewDetailHumanRows({articleId, projectId, reviewConfigHash})

      const humanAssessmentsByUser =
        humanRows.length === 0
          ? []
          : [
              {
                userId: systemActor.id,
                userName: systemActor.name,
                judgments: humanRows.map((row) => {
                  return {
                    id: row.judgmentId,
                    prompt: {originalText: row.promptOriginalText},
                    answer: row.answer,
                    comment: row.comment,
                  }
                }),
              },
            ]

      const humanSummaryAnswer =
        projectReviewConfig.humanJudgmentMode === 'summary'
          ? normalizeSummaryAnswerValue(humanRows[0]?.answer ?? null)
          : null

      let humanAnswersByPrompt: Record<string, Array<{userName: string; answer: string}>> | undefined = undefined
      if (projectReviewConfig?.humanJudgmentMode !== 'summary' && promptIds.length > 0) {
        type HumanRow = {articleId: string; promptId: string; answer: string | null; updatedAt: Date | null}
        const normalizedRows: HumanRow[] = humanRows.map((row) => {
          return {articleId, promptId: row.promptId, answer: row.answer, updatedAt: row.updatedAt}
        })

        // Deduplicate by latest updatedAt for (articleId, promptId)
        const latest = normalizedRows.reduce((acc, row) => {
          const key = `${row.articleId}::${row.promptId}`
          const existing = acc.get(key)
          if (!existing || (row.updatedAt?.getTime() || 0) > (existing.updatedAt?.getTime() || 0)) {
            acc.set(key, row)
          }
          return acc
        }, new Map<string, HumanRow>())

        const latestRows = Array.from(latest.values())
        const covered = new Set(
          latestRows.map((row) => {
            return row.promptId
          }),
        )

        if (covered.size === promptIds.length) {
          const map: Record<string, Array<{userName: string; answer: string}>> = {}
          for (const pid of promptIds) map[pid] = []
          for (const row of latestRows) {
            const arr = map[row.promptId]
            if (row.answer !== null && row.answer !== undefined && arr) {
              arr.push({userName: systemActor.name, answer: row.answer})
            }
          }
          humanAnswersByPrompt = map
        }
      }

      return {
        article,
        covidenceRelatedRecords,
        humanJudgmentMode: projectReviewConfig.humanJudgmentMode,
        humanSummaryAnswer,
        llmSummaryAnswer,
        martFreshness: null,
        prompts: projectPromptRows,
        judgments: judgmentsWithPlaceholders,
        // Cross-project extras
        allJudgments,
        projectsById,
        humanAssessmentsByUser,
        humanAnswersByPrompt,
      }
    } catch (error) {
      console.error('Error fetching article review details:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch article review details', {cause: error})
    }
  },
  {body: t.Object({projectId: t.String(), articleId: t.String()})},
)

import {Elysia, t} from 'elysia'

import type {
  JudgmentAssessmentRecord,
  JudgmentChunkingStrategy,
  JudgmentRecord,
  ProjectMartRefreshStatus,
  PromptRecord,
} from '../../../db/schemaTypes.ts'
import {getArticleSourceMetadataValue} from '../../../utils/articleSourceMetadata.ts'
import {getProviderModelMetadataOptions} from '../../providers/providerModelMetadata.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getJsonValue, getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {
  deriveStrictSummaryAnswer,
  getNormalizedSummaryAnswer,
  normalizeSummaryAnswerValue,
} from '../../utils/judgmentAnswers.ts'
import {getSystemActor} from '../../utils/getSystemActor.ts'
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

type ArticleJudgmentRow = {
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
  modelVersion: string | null
}

type ProjectReviewConfig = {
  humanJudgmentMode?: 'prompt' | 'summary'
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type ProjectReviewDetailMartFreshness = {
  dirtyToken: number | null
  isFresh: boolean
  lastCompletedRefreshToken: number | null
  refreshStatus: ProjectMartRefreshStatus | null
  state: 'fresh' | 'running' | 'stale'
}

type ProjectReviewDetailJudgmentRow = {
  judgmentId: string
  judgmentCreatedAt: unknown
  judgmentUpdatedAt: unknown
  judgmentArticleId: string
  judgmentModelId: string
  judgmentPromptId: string
  judgmentProjectId: string | null
  judgmentUseTitle: boolean
  judgmentUseAbstract: boolean
  judgmentUseFulltext: boolean
  judgmentUseFulltextNoImages: boolean
  judgmentChunkingStrategy: string | null
  judgmentIsAnswered: boolean
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

type ProjectPromptRow = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
  enabled: boolean | null
  criteriaDisposition: 'include' | 'exclude' | null
  originProjectId: string | null
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

const getPromptValue = (row: {promptOriginalText: string; promptHeading: string | null}) => {
  return {originalText: row.promptOriginalText, promptHeading: row.promptHeading}
}

const getProjectReviewDetailJudgmentRows = async (params: {
  projectId: string
  articleId: string
}): Promise<ProjectReviewDetailJudgmentRow[]> => {
  const rows = await getAppDatabaseService().queryJson<ProjectReviewDetailJudgmentRow>(`
    WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = '${escapeSqlString(params.projectId)}'
    )
    SELECT
      j.judgment_id AS judgmentId,
      j.created_at AS judgmentCreatedAt,
      jf.updated_at AS judgmentUpdatedAt,
      j.article_id AS judgmentArticleId,
      j.model_id AS judgmentModelId,
      j.prompt_id AS judgmentPromptId,
      jf.project_id AS judgmentProjectId,
      jf.use_title AS judgmentUseTitle,
      jf.use_abstract AS judgmentUseAbstract,
      jf.use_fulltext AS judgmentUseFulltext,
      jf.use_fulltext_no_images AS judgmentUseFulltextNoImages,
      jf.chunking_strategy AS judgmentChunkingStrategy,
      jf.is_answered AS judgmentIsAnswered,
      j.answered_original AS judgmentAnsweredOriginal,
      TO_JSON(j.answered_original_as_array) AS judgmentAnsweredOriginalAsArray,
      jf.confidence_original AS judgmentConfidenceOriginal,
      jf.explanation AS judgmentExplanation,
      TO_JSON(jf.quotes) AS judgmentQuotes,
      jf.snapshot_project_id AS judgmentSnapshotProjectId,
      jf.snapshot_project_model_name AS judgmentSnapshotProjectModelName,
      p.original_text AS promptOriginalText,
      p.prompt_heading AS promptHeading,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
      pc.provider_kind AS modelProvider,
      m.variant AS modelVersion
    FROM mart.review_article_serving_detail j
    INNER JOIN active_generation active
      ON active.projectId = j.project_id
     AND active.generation = j.generation
    INNER JOIN mart.judgment_fact jf ON jf.judgment_id = j.judgment_id
    INNER JOIN app.prompt p ON p.id = jf.prompt_id
    LEFT JOIN app.model m ON m.id = jf.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE j.project_id = '${escapeSqlString(params.projectId)}'
      AND j.article_id = '${escapeSqlString(params.articleId)}'
    ORDER BY j.prompt_order ASC NULLS LAST, j.created_at DESC NULLS LAST, j.judgment_id ASC
  `)

  return rows
}

const getProjectReviewDetailMartFreshness = async (projectId: string): Promise<ProjectReviewDetailMartFreshness> => {
  const [row] = await getAppDatabaseService().queryJson<{
    dirtyToken: number | null
    lastCompletedRefreshToken: number | null
    refreshStatus: ProjectMartRefreshStatus | null
  }>(`
    SELECT
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken,
      refresh_status AS refreshStatus
    FROM app.project_mart_refresh_state
    WHERE project_id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `)

  const dirtyToken = row?.dirtyToken ?? null
  const lastCompletedRefreshToken = row?.lastCompletedRefreshToken ?? null
  const refreshStatus = row?.refreshStatus ?? null
  const isFresh = dirtyToken === null || (lastCompletedRefreshToken !== null && lastCompletedRefreshToken >= dirtyToken)
  const state = isFresh ? 'fresh' : refreshStatus === 'running' ? 'running' : 'stale'

  return {dirtyToken, isFresh, lastCompletedRefreshToken, refreshStatus, state}
}

const getArticleJudgmentRows = async (articleId: string): Promise<ArticleJudgmentRow[]> => {
  const rows = await getAppDatabaseService().queryJson<ArticleJudgmentRow>(`
    SELECT
      j.id AS judgmentId,
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
          m.variant AS modelVersion
    FROM app.judgment j
    INNER JOIN app.prompt p ON j.prompt_id = p.id
    LEFT JOIN app.model m ON j.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE j.article_id = '${escapeSqlString(articleId)}'
      AND j.deleted_at IS NULL
    ORDER BY j.created_at DESC NULLS LAST, j.id ASC
  `)

  return rows
}

const getJudgmentValue = (row: ArticleJudgmentRow): JudgmentRecord => {
  const answeredOriginalAsArray = getJsonValue(row.judgmentAnsweredOriginalAsArray)
  const quotes = getJsonValue(row.judgmentQuotes)
  return {
    id: row.judgmentId,
    createdAt: getDateValue(row.judgmentCreatedAt) ?? new Date(0),
    updatedAt: getDateValue(row.judgmentUpdatedAt) ?? new Date(0),
    deletedAt: getDateValue(row.judgmentDeletedAt),
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
      : (null as JudgmentRecord['answeredOriginalAsArray']),
    confidenceOriginal: row.judgmentConfidenceOriginal ?? 50,
    explanation: row.judgmentExplanation,
    quotes: Array.isArray(quotes) ? quotes : [],
    snapshotProjectId: row.judgmentSnapshotProjectId,
    snapshotProjectModelName: row.judgmentSnapshotProjectModelName,
  }
}

const getProjectReviewDetailJudgmentValue = (row: ProjectReviewDetailJudgmentRow): JudgmentRecord => {
  const answeredOriginalAsArray = getJsonValue(row.judgmentAnsweredOriginalAsArray)
  const quotes = getJsonValue(row.judgmentQuotes)

  return {
    id: row.judgmentId,
    createdAt: getDateValue(row.judgmentCreatedAt) ?? new Date(0),
    updatedAt: getDateValue(row.judgmentUpdatedAt) ?? new Date(0),
    deletedAt: null,
    articleId: row.judgmentArticleId,
    modelId: row.judgmentModelId,
    promptId: row.judgmentPromptId,
    projectId: row.judgmentProjectId,
    useTitle: row.judgmentUseTitle,
    useAbstract: row.judgmentUseAbstract,
    useFulltext: row.judgmentUseFulltext,
    useFulltextNoImages: row.judgmentUseFulltextNoImages,
    chunkingStrategy: row.judgmentChunkingStrategy as JudgmentChunkingStrategy,
    isAnswered: row.judgmentIsAnswered,
    answeredOriginal: row.judgmentAnsweredOriginal,
    answeredOriginalAsArray: Array.isArray(answeredOriginalAsArray)
      ? answeredOriginalAsArray.filter((value): value is string => {
          return typeof value === 'string'
        })
      : null,
    confidenceOriginal: row.judgmentConfidenceOriginal,
    explanation: row.judgmentExplanation,
    quotes: Array.isArray(quotes) ? quotes : [],
    snapshotProjectId: row.judgmentSnapshotProjectId,
    snapshotProjectModelName: row.judgmentSnapshotProjectModelName,
  }
}

const getModelThinkingValue = (row: {modelMetadataJson: unknown}) => {
  return getProviderModelMetadataOptions(getJsonValue(row.modelMetadataJson)).thinking
}

const getMatchesProjectReviewConfig = (params: {row: ArticleJudgmentRow; projectReviewConfig: ProjectReviewConfig}) => {
  return (
    (params.projectReviewConfig.modelId === null || params.row.judgmentModelId === params.projectReviewConfig.modelId)
    && (params.row.judgmentUseTitle ?? true) === params.projectReviewConfig.useTitle
    && (params.row.judgmentUseAbstract ?? true) === params.projectReviewConfig.useAbstract
    && (params.row.judgmentUseFulltext ?? false) === params.projectReviewConfig.useFulltext
    && (params.row.judgmentUseFulltextNoImages ?? false) === params.projectReviewConfig.useFulltextNoImages
  )
}

const getMatchesProjectReviewSource = (params: {projectId: string; row: ArticleJudgmentRow}) => {
  return (params.row.judgmentProjectId ?? params.row.judgmentSnapshotProjectId) === params.projectId
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
  articleId: string
  importRoute: string | null
  studyKey: string | null
}): Promise<CovidenceRelatedRecord[]> => {
  if (!params.importRoute || !params.studyKey) {
    return []
  }

  const rows = await getAppDatabaseService().queryJson<{
    articleExternalId: string | null
    articleTitle: string
    id: string
    sourceMetadata: unknown
  }>(`
    SELECT
      id,
      article_id AS articleExternalId,
      article_title AS articleTitle,
      source_metadata AS sourceMetadata
    FROM app.article
    WHERE import_route = '${escapeSqlString(params.importRoute)}'
      AND json_extract_string(source_metadata, '$.covidence.studyKey') = '${escapeSqlString(params.studyKey)}'
    ORDER BY article_title ASC, id ASC
  `)

  return rows.map((row) => {
    const covidence = getArticleSourceMetadataValue(getJsonValue(row.sourceMetadata))?.covidence

    return {
      articleExternalId: row.articleExternalId,
      articleTitle: row.articleTitle,
      covidenceIds: covidence?.covidenceIds ?? [],
      hasDuplicateStudyRecords: covidence?.hasDuplicateStudyRecords ?? false,
      hasStudyDecisionConflict: covidence?.hasStudyDecisionConflict ?? false,
      id: row.id,
      isCurrentRecord: row.id === params.articleId,
      isSeededHumanJudgmentAnswered: covidence?.isSeededHumanJudgmentAnswered ?? false,
      referenceIds: covidence?.referenceIds ?? [],
      seededHumanJudgmentAnswer: covidence?.seededHumanJudgmentAnswer ?? null,
      stageMembership: covidence?.stageMembership ?? {},
    }
  })
}

export const projectsRoutesPostArticleReviewDetails = new Elysia().post(
  '/api/projectsreview',
  async ({body}) => {
    try {
      const {projectId, articleId} = body

      await assertProjectIsActive(projectId)

      const [article] = await getAppQueryService().getFullArticlesByIds([articleId])

      if (!article) {
        throw new Error('Article not found')
      }

      const covidenceRelatedRecordsPromise = getCovidenceRelatedRecords({
        articleId,
        importRoute: article.importRoute,
        studyKey: article.sourceMetadata?.covidence?.studyKey ?? null,
      })

      const projectPromptRowsPromise: Promise<ProjectPromptRow[]> = getAppDatabaseService()
        .queryJson<ProjectPromptRow>(`
          SELECT
            p.id AS id,
            p.original_text AS originalText,
            p.prompt_heading AS promptHeading,
            pp.prompt_order AS "order",
            p.type AS type,
            pp.enabled AS enabled,
            pp.criteria_disposition AS criteriaDisposition,
            pp.origin_project_id AS originProjectId
          FROM app.project_prompt pp
          INNER JOIN app.prompt p ON p.id = pp.prompt_id
          WHERE pp.project_id = '${escapeSqlString(projectId)}'
          ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC
        `)
      const projectReviewConfigPromise: Promise<ProjectReviewConfig | null> =
        getAppQueryService().getProjectReviewConfig(projectId)
      const allArticleJudgmentsPromise: Promise<ArticleJudgmentRow[]> = getArticleJudgmentRows(articleId)
      const martFreshnessPromise: Promise<ProjectReviewDetailMartFreshness> =
        getProjectReviewDetailMartFreshness(projectId)
      const [projectPromptRows, projectReviewConfig, allArticleJudgments, martFreshness]: [
        ProjectPromptRow[],
        ProjectReviewConfig | null,
        ArticleJudgmentRow[],
        ProjectReviewDetailMartFreshness,
      ] = await Promise.all([
        projectPromptRowsPromise,
        projectReviewConfigPromise,
        allArticleJudgmentsPromise,
        martFreshnessPromise,
      ])

      if (!projectReviewConfig) {
        throw new Error('Project not found')
      }

      const projectReviewDetailJudgmentRows = martFreshness.isFresh
        ? await getProjectReviewDetailJudgmentRows({projectId, articleId})
        : []

      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })
      const enabledPromptRows = projectPromptRows.filter((p) => {
        return p.enabled === true
      })
      const enabledPromptIds = enabledPromptRows.map((p) => {
        return p.id
      })
      const summaryCriteria = enabledPromptRows.map((row) => {
        return {promptId: row.id, criteriaDisposition: row.criteriaDisposition}
      })
      const enabledPromptIdSet = new Set(enabledPromptIds)
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = p.order ?? idx
          acc[p.id] = ord
          return acc
        },
        {} as Record<string, number>,
      )
      const appScopedArticleJudgments: ArticleJudgmentRow[] = allArticleJudgments.filter((row) => {
        return (
          enabledPromptIdSet.has(row.judgmentPromptId)
          && getMatchesProjectReviewSource({projectId, row})
          && getMatchesProjectReviewConfig({row, projectReviewConfig})
        )
      })
      const projectReviewDetailJudgmentDetails: ReviewJudgmentDetail[] = projectReviewDetailJudgmentRows.map((row) => {
        return {
          judgment: getProjectReviewDetailJudgmentValue(row),
          prompt: getPromptValue(row),
          modelName: row.modelName,
          modelProvider: row.modelProvider,
          modelThinking: getModelThinkingValue(row),
          modelVersion: row.modelVersion,
        }
      })
      const projectReviewDetailJudgmentIdSet = new Set<string>(
        projectReviewDetailJudgmentDetails.map((detail) => {
          return detail.judgment.id
        }),
      )
      const fallbackAppJudgmentDetails: ReviewJudgmentDetail[] = appScopedArticleJudgments
        .filter((row) => {
          return !projectReviewDetailJudgmentIdSet.has(row.judgmentId)
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

      const judgmentIds: string[] = articleJudgments.map((j) => {
        return j.judgment.id
      })
      const assessments: AssessmentRow[] =
        judgmentIds.length > 0
          ? await getAppDatabaseService().queryJson<AssessmentRow>(`
              SELECT
                id,
                judgment_id AS judgmentId,
                assessment_is_correct AS assessmentIsCorrect,
                assessment_comment AS assessmentComment,
                created_at AS createdAt,
                updated_at AS updatedAt
              FROM app.judgment_assessment
              WHERE judgment_id IN (${getQuotedStringList(judgmentIds).join(', ')})
            `)
          : []
      const normalizedAssessments = assessments.map((assessment) => {
        return getAssessmentValue(assessment)
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

      const judgmentIdSet = new Set(judgmentIds)
      const allJudgments = allArticleJudgments
        .filter((row) => {
          return !judgmentIdSet.has(row.judgmentId)
        })
        .map((row) => {
          return {
            ...getJudgmentValue(row),
            prompt: getPromptValue(row),
            modelName: row.modelName,
            modelProvider: row.modelProvider,
            modelThinking: getModelThinkingValue(row),
            modelVersion: row.modelVersion,
          }
        })

      // Resolve project names for snapshotProjectId when present
      const snapshotProjectIds = Array.from(
        new Set(
          allJudgments
            .map((j) => {
              return j.snapshotProjectId
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
        acc[row.id] = {name: row.name}
        return acc
      }, {})

      const systemActor = getSystemActor()

      const humanRows =
        projectReviewConfig?.humanJudgmentMode === 'summary'
          ? await getAppDatabaseService().queryJson<{
              judgmentId: string
              promptId: string
              answer: string | null
              comment: string | null
              promptOriginalText: string
              promptOrder: number | null
            }>(`
            SELECT
              jhs.id AS judgmentId,
              'summary' AS promptId,
              jhs.answer AS answer,
              NULL AS comment,
              'Overall human screening decision' AS promptOriginalText,
              0 AS promptOrder
            FROM app.judgment_human_summary jhs
            WHERE jhs.article_id = '${escapeSqlString(articleId)}'
              AND jhs.project_id = '${escapeSqlString(projectId)}'
              AND NULLIF(TRIM(COALESCE(jhs.answer, '')), '') IS NOT NULL
            ORDER BY jhs.updated_at DESC NULLS LAST
          `)
          : await getAppDatabaseService().queryJson<{
              judgmentId: string
              promptId: string
              answer: string | null
              comment: string | null
              promptOriginalText: string
              promptOrder: number | null
            }>(`
            SELECT
              jh.id AS judgmentId,
              jh.prompt_id AS promptId,
              jh.answer AS answer,
              jh.comment AS comment,
              p.original_text AS promptOriginalText,
              pp.prompt_order AS promptOrder
            FROM app.judgment_human jh
            INNER JOIN app.prompt p ON p.id = jh.prompt_id
            INNER JOIN app.project_prompt pp
              ON pp.prompt_id = p.id
             AND pp.project_id = '${escapeSqlString(projectId)}'
            WHERE jh.article_id = '${escapeSqlString(articleId)}'
              AND jh.project_id = '${escapeSqlString(projectId)}'
              AND jh.is_answered = TRUE
            ORDER BY pp.prompt_order ASC NULLS LAST, jh.updated_at DESC NULLS LAST
          `)

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
        const rows = await getAppDatabaseService().queryJson<{
          articleId: string
          promptId: string
          answer: string | null
          updatedAt: unknown
        }>(`
          SELECT
            article_id AS articleId,
            prompt_id AS promptId,
            answer,
            updated_at AS updatedAt
          FROM app.judgment_human
          WHERE article_id = '${escapeSqlString(articleId)}'
            AND answer IS NOT NULL
        `)
        const normalizedRows: HumanRow[] = rows.map((row) => {
          return {...row, updatedAt: getDateValue(row.updatedAt)}
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

      const covidenceRelatedRecords = await covidenceRelatedRecordsPromise

      return {
        article,
        covidenceRelatedRecords,
        humanJudgmentMode: projectReviewConfig.humanJudgmentMode,
        humanSummaryAnswer,
        llmSummaryAnswer,
        martFreshness,
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

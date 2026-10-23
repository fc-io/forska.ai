import {Elysia, t} from 'elysia'

import {getArticleMetadataLines} from '../../../agent/judge/articleMetadataPrompt.ts'
import type {ArticleMetadataLine} from '../../../utils/articleMetadataText.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {archivedProjectAccessErrorMessage, assertProjectIsActive} from './projectAccessGuard.ts'
import type {
  ArticleFullTextRow,
  ProjectReviewConfig,
  ReviewJudgment,
} from './projectsRoutesPostArticleReviewDetails/articleReviewDetailTypes.ts'
import {getAppArticleDetailRow} from './projectsRoutesPostArticleReviewDetails/getAppArticleDetailRow.ts'
import {getArticleJudgmentRows} from './projectsRoutesPostArticleReviewDetails/getArticleJudgmentRows.ts'
import {getArticleRecordFromServing} from './projectsRoutesPostArticleReviewDetails/getArticleRecordFromServing.ts'
import {getArticleReviewHumanDetails} from './projectsRoutesPostArticleReviewDetails/getArticleReviewHumanDetails.ts'
import {getArticleReviewJudgmentDetails} from './projectsRoutesPostArticleReviewDetails/getArticleReviewJudgmentDetails.ts'
import {getArticleReviewJudgmentsWithPlaceholders} from './projectsRoutesPostArticleReviewDetails/getArticleReviewJudgmentsWithPlaceholders.ts'
import {getCovidenceRelatedRecords} from './projectsRoutesPostArticleReviewDetails/getCovidenceRelatedRecords.ts'
import {getJudgmentValue} from './projectsRoutesPostArticleReviewDetails/getJudgmentValue.ts'
import {getModelThinkingValue} from './projectsRoutesPostArticleReviewDetails/getModelThinkingValue.ts'
import {getProjectReviewDetailsWorkloadContext} from './projectsRoutesPostArticleReviewDetails/getProjectReviewDetailsWorkloadContext.ts'
import {getPromptValue} from './projectsRoutesPostArticleReviewDetails/getPromptValue.ts'
import {getUnavailableReviewDetail} from './projectsRoutesPostArticleReviewDetails/getUnavailableReviewDetail.ts'
import {readProjectReviewArticleDetail} from './projectsRoutesPostArticleReviewDetails/readProjectReviewArticleDetail.ts'

const getJudgeArticleMetadataLines = async (params: {articleId: string; projectId: string}) => {
  const [article] = await getAppQueryService().getFullArticlesByIds([params.articleId], {
    includeFullText: false,
    projectId: params.projectId,
  })

  return article ? getArticleMetadataLines(article) : null
}

const getArticleMetadataForReviewDetail = async (params: {
  articleId: string
  projectId: string
  useMetadata: boolean
}): Promise<ArticleMetadataLine[] | null> => {
  return params.useMetadata ? getJudgeArticleMetadataLines(params) : null
}

export const projectsRoutesPostArticleReviewDetails = new Elysia().post(
  '/api/projectsreview',
  async ({body, set}) => {
    try {
      const {projectId, articleId} = body

      try {
        await assertProjectIsActive(projectId)
      } catch (error) {
        if (error instanceof Error && error.message === archivedProjectAccessErrorMessage) {
          set.status = 409
          return {
            article: null,
            code: 'PROJECT_ARCHIVED',
            message: 'Unarchive this project before reviewing articles.',
            reason: archivedProjectAccessErrorMessage,
            status: 'archived',
          }
        }

        throw error
      }

      const projectReviewConfigPromise: Promise<ProjectReviewConfig | null> =
        getAppQueryService().getProjectReviewConfig(projectId)
      const reviewConfigHashPromise = getCurrentReviewConfigHash(projectId)
      const projectReviewConfig = await projectReviewConfigPromise
      const reviewConfigHash = await reviewConfigHashPromise

      if (!projectReviewConfig) {
        throw new Error('Project not found')
      }

      const articleDetailResult = await readProjectReviewArticleDetail({articleId, projectId, reviewConfigHash})
      const servingArticleDetail =
        articleDetailResult.status === 'rejected' ? null : (articleDetailResult.rows[0] ?? null)
      const articleDetail = servingArticleDetail ?? (await getAppArticleDetailRow({articleId, projectId}))

      if (!articleDetail) {
        return getUnavailableReviewDetail({articleId, reason: 'article not in project scope'})
      }

      const [articleFullTextRows, allArticleJudgments, articleMetadata] = await Promise.all([
        getAppDatabaseService().queryJson<ArticleFullTextRow>(
          `
          SELECT
            TO_JSON(article_authors) AS articleAuthors,
            article_summary AS articleSummary,
            full_text AS fullText,
            full_text_char_count AS fullTextCharCount,
            full_text_html AS fullTextHtml,
            full_text_original_format AS fullTextOriginalFormat,
            full_text_source AS fullTextSource,
            import_route AS importRoute
          FROM app.article
          WHERE id = ${getSqlLiteral(articleId)}
          LIMIT 1
        `,
          getProjectReviewDetailsWorkloadContext({maxResultRows: 1, operation: 'articleFullText', projectId}),
        ),
        getArticleJudgmentRows({articleId, projectId}),
        getArticleMetadataForReviewDetail({
          articleId,
          projectId,
          useMetadata: projectReviewConfig.useMetadata ?? false,
        }),
      ])
      const article = getArticleRecordFromServing({
        articleId,
        detail: articleDetail,
        fullText: articleFullTextRows[0] ?? null,
      })
      const covidenceRelatedRecordsResult = await getCovidenceRelatedRecords({article, projectId})
      const covidenceRelatedRecords = covidenceRelatedRecordsResult.records

      const {
        articleJudgments,
        enabledPromptRows,
        fallbackAppJudgmentDetails,
        llmSummaryAnswer,
        projectPromptRows,
        projectReviewDetailJudgmentRows,
        promptIds,
        promptOrderMap,
        servingJudgmentResult,
      } = await getArticleReviewJudgmentDetails({
        allArticleJudgments,
        articleId,
        projectId,
        projectReviewConfig,
        reviewConfigHash,
      })

      const judgmentsWithPlaceholders = await getArticleReviewJudgmentsWithPlaceholders({
        articleJudgments,
        enabledPromptRows,
        fallbackAppJudgmentDetails,
        projectId,
        projectReviewDetailJudgmentRows,
        promptOrderMap,
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
          ? await getAppDatabaseService().queryJson<{id: string; name: string}>(
              `
              SELECT id, name
              FROM app.project
              WHERE id IN (${getQuotedStringList(snapshotProjectIds).join(', ')})
            `,
              getProjectReviewDetailsWorkloadContext({
                maxResultRows: snapshotProjectIds.length,
                operation: 'snapshotProjectNames',
                projectId,
              }),
            )
          : []
      const projectsById = projectNameRows.reduce<Record<string, {name: string}>>((acc, row) => {
        return {...acc, [row.id]: {name: row.name}}
      }, {})

      const {detailSource, humanAnswersByPrompt, humanAssessmentsByUser, humanSummaryAnswer, repairRequested} =
        await getArticleReviewHumanDetails({
          articleId,
          projectId,
          projectReviewConfig,
          promptIds,
          reviewConfigHash,
          servingArticleDetail,
          servingJudgmentResult,
        })

      return {
        article,
        articleMetadata,
        covidenceRelatedRecords,
        covidenceRelatedRecordsOverflow: covidenceRelatedRecordsResult.overflow,
        detailSource,
        repairRequested,
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

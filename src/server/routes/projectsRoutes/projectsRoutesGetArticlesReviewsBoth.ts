import {Elysia, t} from 'elysia'

import {queryArticlesReviewsBothFromOlap} from '../../../services/olap/articlesReviewsBothOlap.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviewsBoth = new Elysia().post(
  '/api/articlesreviewsboth',
  async ({body}) => {
    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)

    await assertProjectIsActive(body.projectId)

    const result = await queryArticlesReviewsBothFromOlap({
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      projectId: body.projectId,
      page,
      limit,
      from: body.from,
      to: body.to,
      search: body.search,
      prompts: body.prompts,
    })

    const articleIds = result.data.map((a) => {
      return a.id
    })
    const fullTextRows = await getAppQueryService().getReviewHydrationRows(articleIds, {projectId: body.projectId})
    const fullTextById = fullTextRows.reduce(
      (acc, row) => {
        return {...acc, [row.id]: row}
      },
      {} as Record<string, (typeof fullTextRows)[number]>,
    )

    // Transform response to match expected API format
    const data = result.data.map((article) => {
      const fullText = fullTextById[article.id]
      const hydratedFields = fullText
        ? {
            articleTitle: fullText.articleTitle,
            articleCreatedAt: fullText.articleCreatedAt,
            articleUpdatedAt: fullText.articleUpdatedAt,
            journalTitle: article.journalTitle,
            articleId: fullText.articleId,
            arxivId: fullText.arxivId,
            biorxivId: fullText.biorxivId,
            canonicalArticleId: fullText.canonicalArticleId,
            canonicalSourceMetadata: fullText.canonicalSourceMetadata,
            doi: fullText.doi,
            medrxivId: fullText.medrxivId,
            originalData: fullText.originalData,
            pubmedId: fullText.pubmedId,
            url: fullText.url,
            fullTextPDF: fullText.fullTextPDF,
            fullTextFetchedAt: fullText.fullTextFetchedAt,
            fullTextConversionStatus: fullText.fullTextConversionStatus,
            scopedImportMetadata: fullText.scopedImportMetadata,
            selectedExternalArticleId: fullText.selectedExternalArticleId,
            selectedImportRecordId: fullText.selectedImportRecordId,
            selectedImportRouteId: fullText.selectedImportRouteId,
            selectedSourceRecordKey: fullText.selectedSourceRecordKey,
            sourceMetadata: fullText.sourceMetadata,
          }
        : {
            articleTitle: article.articleTitle,
            articleCreatedAt: article.articleCreatedAt,
            articleUpdatedAt: article.articleUpdatedAt,
            journalTitle: article.journalTitle,
            articleId: null,
            url: null,
            fullTextPDF: null,
            fullTextFetchedAt: null,
            fullTextConversionStatus: null,
            sourceMetadata: (article as {sourceMetadata?: unknown}).sourceMetadata ?? null,
          }
      return {
        id: article.id,
        ...hydratedFields,
        judgments: article.judgments.map((j) => {
          return {
            id: j.id,
            createdAt: new Date(j.createdAt),
            articleId: j.articleId,
            promptId: j.promptId,
            modelId: j.modelId,
            answeredOriginal: j.answeredOriginal,
            answeredOriginalAsArray: j.answeredOriginalAsArray,
            explanation: j.explanation,
            quotes: Array.isArray(j.quotes) ? j.quotes : null,
          }
        }),
        humanJudgmentMode: article.humanJudgmentMode,
        humanSummaryAnswer: article.humanSummaryAnswer,
        llmSummaryAnswer: article.llmSummaryAnswer,
        ...(article.humanJudgmentMode !== 'summary' && article.humanAnswersByPrompt
          ? {humanAnswersByPrompt: article.humanAnswersByPrompt}
          : {}),
      }
    })

    return {data, totalCount: result.totalCount, page: result.page, limit: result.limit, totalPages: result.totalPages}
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      hasDuplicateStudyRecords: t.Optional(t.Boolean()),
      hasStudyDecisionConflict: t.Optional(t.Boolean()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)

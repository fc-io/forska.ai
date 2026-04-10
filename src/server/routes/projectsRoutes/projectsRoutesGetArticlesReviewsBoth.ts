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
    const fullTextRows = await getAppQueryService().getReviewHydrationRows(articleIds)
    const fullTextById = fullTextRows.reduce(
      (acc, row) => {
        return {...acc, [row.id]: row}
      },
      {} as Record<string, (typeof fullTextRows)[number]>,
    )

    // Transform response to match expected API format
    const data = result.data.map((article) => {
      const fullText = fullTextById[article.id]
      return {
        id: article.id,
        articleTitle: fullText ? fullText.articleTitle : article.articleTitle,
        articleCreatedAt: fullText ? fullText.articleCreatedAt : article.articleCreatedAt,
        articleUpdatedAt: fullText ? fullText.articleUpdatedAt : article.articleUpdatedAt,
        journalTitle: article.journalTitle,
        articleId: fullText?.articleId ?? null,
        url: fullText?.url ?? null,
        fullTextPDF: fullText?.fullTextPDF ?? null,
        fullTextFetchedAt: fullText?.fullTextFetchedAt ?? null,
        fullTextConversionStatus: fullText?.fullTextConversionStatus ?? null,
        sourceMetadata: fullText?.sourceMetadata ?? (article as {sourceMetadata?: unknown}).sourceMetadata ?? null,
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
        humanAnswersByPrompt: article.humanAnswersByPrompt,
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

import {Elysia, t} from 'elysia'

import {queryArticlesReviewsBothFromClickHouse} from '../../../services/clickhouse/articlesReviewsBothClickHouse.ts'

/**
 * GET articles that have BOTH LLM and human assessments for all project prompts.
 *
 * Uses ClickHouse for LLM judgment queries (fast aggregation)
 * and PostgreSQL for human judgment queries (smaller dataset).
 */
export const projectsRoutesGetArticlesReviewsBoth = new Elysia().post(
  '/api/articlesreviewsboth',
  async ({body}) => {
    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)

    const result = await queryArticlesReviewsBothFromClickHouse({
      projectId: body.projectId,
      page,
      limit,
      from: body.from,
      to: body.to,
      search: body.search,
      prompts: body.prompts,
    })

    // Transform response to match expected API format
    const data = result.data.map((article) => {
      return {
        id: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
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
            quotes: j.quotes ? (JSON.parse(j.quotes) as unknown) : null,
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
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)

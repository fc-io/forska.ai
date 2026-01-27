/**
 * Articles reviews API endpoint - ClickHouse implementation.
 *
 * This is the Phase 6 implementation using ClickHouse for dramatically faster
 * GROUP BY + ORDER BY + HAVING queries on judgment data.
 *
 * Performance improvement: ~50s (PostgreSQL) -> ~2s (ClickHouse)
 *
 * Uses PostgreSQL only for project metadata (prompts, routes, curated articles).
 * All judgment data is queried from ClickHouse.
 */
import {inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles} from '../../../db/schema.ts'
import {queryArticlesReviewsFromClickHouse} from '../../../services/clickhouse/articlesReviewsClickHouse.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      console.log('[Articles Reviews API] Request:', {
        projectId: body.projectId,
        page: body.page,
        limit: body.limit,
        from: body.from,
        to: body.to,
        search: body.search,
        promptFilters: Object.keys(body.prompts || {}).length,
      })

      const page = parseInt(body?.page ?? '1', 10)
      const limit = parseInt(body?.limit ?? '100', 10)

      const result = await queryArticlesReviewsFromClickHouse({
        projectId: body.projectId,
        page,
        limit,
        from: body.from,
        to: body.to,
        search: body.search,
        prompts: body.prompts,
      })

      const db = getDatabase()
      const articleIds = result.data.map((a) => {
        return a.id
      })
      const fullTextRows =
        articleIds.length > 0
          ? await db
              .select({
                id: articles.id,
                articleTitle: articles.articleTitle,
                articleId: articles.articleId,
                url: articles.url,
                fullTextPDF: articles.fullTextPDF,
                fullTextFetchedAt: articles.fullTextFetchedAt,
                fullTextConversionStatus: articles.fullTextConversionStatus,
                originalData: articles.originalData,
              })
              .from(articles)
              .where(inArray(articles.id, articleIds))
          : []
      const fullTextById = fullTextRows.reduce(
        (acc, row) => {
          return {...acc, [row.id]: row}
        },
        {} as Record<string, (typeof fullTextRows)[number]>,
      )
      const data = result.data.map((article) => {
        const fullText = fullTextById[article.id]
        return {
          ...article,
          articleTitle: fullText?.articleTitle ?? article.articleTitle,
          articleId: fullText?.articleId ?? null,
          url: fullText?.url ?? null,
          fullTextPDF: fullText?.fullTextPDF ?? null,
          fullTextFetchedAt: fullText?.fullTextFetchedAt ?? null,
          fullTextConversionStatus: fullText?.fullTextConversionStatus ?? null,
          originalData: fullText?.originalData ?? null,
        }
      })

      console.log(`[Articles Reviews API] Returning ${result.data.length} articles`)

      return {...result, data}
    } catch (error) {
      console.error('[Articles Reviews API] Error:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews')
    }
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

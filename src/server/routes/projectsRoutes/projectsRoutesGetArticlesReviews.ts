import {and, desc, eq, inArray, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {buildArticlesReviewsQueryContext, fetchProjectMetadata} from './articlesReviewsQueryBuilder.ts'

/**
 * Optimized articles reviews API using denormalized judgment fields.
 *
 * Key optimizations:
 * 1. Query judgments directly (no JOIN to articles table)
 * 2. Use denormalized fields: articleTitle, articleCreatedAt, articleImportRoute
 * 3. Use subquery for project_articles (scales well for large curated article sets)
 * 4. Match import routes by TEXT instead of UUID EXISTS
 * 5. Count query moved to separate endpoint (/api/articlesreviewscount) for faster initial load
 */
export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      const db = getDatabase()

      // Parse pagination params with defaults
      const page = parseInt(body?.page || '1', 10)
      const limit = parseInt(body?.limit || '100', 10)
      const offset = (page - 1) * limit

      // === PARALLEL METADATA QUERIES ===
      console.time('parallel metadata queries')
      const metadata = await fetchProjectMetadata(db, body.projectId)
      console.timeEnd('parallel metadata queries')

      if (metadata.projectPromptRows.length === 0) {
        return {data: [], totalCount: null, page, limit, totalPages: null}
      }

      // === BUILD QUERY CONTEXT ===
      console.time('query preparation')
      const queryContext = buildArticlesReviewsQueryContext(
        {projectId: body.projectId, from: body.from, to: body.to, search: body.search, prompts: body.prompts},
        metadata,
      )
      console.timeEnd('query preparation')

      if (!queryContext) {
        return {data: [], totalCount: null, page, limit, totalPages: null}
      }

      const {promptIds, promptOrderMap, combinedWhereCondition, havingCondition} = queryContext

      // === PAGINATED QUERY ===
      // Get page of article IDs, ordered by articleCreatedAt (denormalized)
      // NOTE: Count query is now in a separate endpoint for faster initial load
      console.time('grouped judgments')
      const groupedPage = db
        .select({
          articleId: judgments.articleId,
          articleCreatedAt: sql<Date>`MAX(${judgments.articleCreatedAt})`.as('article_created_at'),
        })
        .from(judgments)
        .where(combinedWhereCondition)
        .groupBy(judgments.articleId)
        .having(havingCondition)
        .orderBy(desc(sql`MAX(${judgments.articleCreatedAt})`))
        .limit(limit)
        .offset(offset)
        .as('page_articles')
      console.timeEnd('grouped judgments')
      console.time('judgments fetch')
      // === FETCH JUDGMENTS FOR PAGE ===
      // Get all judgments for the paged articles

      // DEBUG: Log the SQL for EXPLAIN ANALYZE
      const debugQuery = db
        .select({judgment: judgments})
        .from(judgments)
        .innerJoin(groupedPage, eq(groupedPage.articleId, judgments.articleId))
        .where(and(inArray(judgments.promptId, promptIds), isNull(judgments.deletedAt)))
        .toSQL()
      console.log('\n=== COPY THIS SQL FOR EXPLAIN ANALYZE ===')
      console.log('EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)')
      console.log(debugQuery.sql)
      console.log('\n=== PARAMETERS ===')
      console.log(JSON.stringify(debugQuery.params, null, 2))
      console.log('=== END ===\n')

      const allJudgmentRows = await db
        .select({judgment: judgments})
        .from(judgments)
        .innerJoin(groupedPage, eq(groupedPage.articleId, judgments.articleId))
        .where(and(inArray(judgments.promptId, promptIds), isNull(judgments.deletedAt)))
      console.timeEnd('judgments fetch')
      console.time('result processing')
      const judgmentsRows = allJudgmentRows.map(({judgment}) => {
        return judgment
      })

      // Group judgments by article
      const judgmentsByArticle = judgmentsRows.reduce<Record<string, Array<(typeof judgmentsRows)[number]>>>(
        (acc, judgment) => {
          const articleJudgments = acc[judgment.articleId] ?? []
          return {...acc, [judgment.articleId]: [...articleJudgments, judgment]}
        },
        {},
      )

      // === BUILD RESULT ===
      // Use denormalized fields from judgments to construct article data
      const result = Object.entries(judgmentsByArticle).map(([articleId, articleJudgments]) => {
        // Sort judgments by prompt order
        const sorted = [...articleJudgments].sort((a, b) => {
          const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
          const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
          return ao - bo
        })

        // Use denormalized article data from any judgment (they all have the same values)
        const firstJudgment = sorted[0]

        return {
          id: articleId,
          articleTitle: firstJudgment?.articleTitle ?? null,
          articleCreatedAt: firstJudgment?.articleCreatedAt ?? null,
          articleUpdatedAt: firstJudgment?.articleUpdatedAt ?? null,
          judgments: sorted,
        }
      })

      // Sort result by articleCreatedAt descending (to match pagination order)
      result.sort((a, b) => {
        const aDate = a.articleCreatedAt?.getTime() ?? 0
        const bDate = b.articleCreatedAt?.getTime() ?? 0
        return bDate - aDate
      })
      console.timeEnd('result processing')

      // Return data immediately - totalCount/totalPages come from separate endpoint
      return {data: result, totalCount: null, page, limit, totalPages: null}
    } catch (error) {
      console.error('Error fetching articles reviews:', error)
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

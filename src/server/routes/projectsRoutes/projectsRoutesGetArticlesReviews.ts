import {and, asc, gt, type SQL} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {buildProgressiveFetchContext, fetchProjectMetadata, passesAnswerFilters} from './articlesReviewsQueryBuilder.ts'

/**
 * Progressive fetch articles reviews API.
 *
 * Key optimizations:
 * 1. NO GROUP BY on the database - use index scan with LIMIT
 * 2. Fetch batches ordered by article_id (uses index: prompt_id, article_id)
 * 3. Apply answer filters in memory (fast - only processes batches, not millions of rows)
 * 4. Cursor-based pagination using article_id for stability
 *
 * Why this is fast:
 * - PostgreSQL uses Index Scan with early termination (LIMIT)
 * - Never scans the full table - fetches only what's needed
 * - Answer filtering in memory is O(batch_size), not O(table_size)
 */
export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      const db = getDatabase()

      // Parse pagination params with defaults
      const page = parseInt(body?.page ?? '1', 10)
      const limit = parseInt(body?.limit ?? '100', 10)

      // === PARALLEL METADATA QUERIES ===
      console.time('metadata')
      const metadata = await fetchProjectMetadata(db, body.projectId)
      console.timeEnd('metadata')

      if (metadata.projectPromptRows.length === 0) {
        return {data: [], totalCount: null, page, limit, totalPages: null}
      }

      // === BUILD QUERY CONTEXT ===
      console.time('context')
      const context = buildProgressiveFetchContext(
        {projectId: body.projectId, from: body.from, to: body.to, search: body.search, prompts: body.prompts},
        metadata,
      )
      console.timeEnd('context')

      if (!context) {
        return {data: [], totalCount: null, page, limit, totalPages: null}
      }

      const {promptIds, promptOrderMap, whereCondition, answerFilters} = context

      // === PROGRESSIVE FETCH ===
      // Instead of GROUP BY (scans all rows), fetch batches using index scan
      // and filter in memory. Much faster for large tables.
      console.time('progressive fetch')

      const BATCH_SIZE = limit * 5 // Fetch 5x limit to account for filtering
      const MAX_ITERATIONS = 50 // Safety limit
      const ARTICLES_NEEDED = page * limit // Need enough articles to reach the requested page

      // Type for judgment row from the database
      type JudgmentRow = typeof judgments.$inferSelect

      interface ArticleResult {
        articleId: string
        judgments: JudgmentRow[]
        articleTitle: string | null
        articleCreatedAt: Date | null
        articleUpdatedAt: Date | null
      }

      const matchingArticles: ArticleResult[] = []
      let cursor: string | null = null
      let iterations = 0
      let noMoreData = false

      while (matchingArticles.length < ARTICLES_NEEDED && iterations < MAX_ITERATIONS && !noMoreData) {
        iterations++

        // Build WHERE condition with cursor
        const cursorCondition: SQL | undefined = cursor ? gt(judgments.articleId, cursor) : undefined
        const batchWhere: SQL = cursorCondition
          ? (and(whereCondition, cursorCondition) ?? whereCondition)
          : whereCondition

        // Fetch batch using index scan (fast!)
        // Order by article_id for stable pagination and to group judgments naturally
        const batch = await db
          .select({judgment: judgments})
          .from(judgments)
          .where(batchWhere)
          .orderBy(asc(judgments.articleId))
          .limit(BATCH_SIZE)

        if (batch.length === 0) {
          noMoreData = true
          break
        }

        // Group by article in memory
        const grouped = new Map<string, JudgmentRow[]>()
        for (const row of batch) {
          const existing = grouped.get(row.judgment.articleId) ?? []
          existing.push(row.judgment)
          grouped.set(row.judgment.articleId, existing)
        }

        // Apply answer filters in memory and collect matching articles
        for (const [articleId, articleJudgments] of grouped) {
          // Check if this article passes the answer filters
          if (passesAnswerFilters(articleJudgments, answerFilters)) {
            // Only keep judgments for the project's enabled prompts
            const relevantJudgments = articleJudgments.filter((j) => {
              return promptIds.includes(j.promptId)
            })

            if (relevantJudgments.length > 0) {
              const firstJudgment = relevantJudgments[0]
              matchingArticles.push({
                articleId,
                judgments: relevantJudgments,
                articleTitle: firstJudgment?.articleTitle ?? null,
                articleCreatedAt: firstJudgment?.articleCreatedAt ?? null,
                articleUpdatedAt: firstJudgment?.articleUpdatedAt ?? null,
              })
            }
          }
        }

        // Update cursor to last article_id we saw
        const lastRow = batch[batch.length - 1]
        if (lastRow) {
          cursor = lastRow.judgment.articleId
        }
      }

      console.timeEnd('progressive fetch')
      console.log(
        `🔄 Progressive fetch: ${iterations} batches, ${matchingArticles.length} articles found, page ${page}`,
      )

      // === PAGINATION ===
      // Extract the page we need from the accumulated results
      const startIndex = (page - 1) * limit
      const pageArticles = matchingArticles.slice(startIndex, startIndex + limit)

      // === BUILD RESULT ===
      console.time('result processing')
      const result = pageArticles.map((article) => {
        // Sort judgments by prompt order
        const sorted = [...article.judgments].sort((a, b) => {
          const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
          const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
          return ao - bo
        })

        // Compute judged status for frontend display
        const judgedPromptIds = [
          ...new Set(
            sorted.map((j) => {
              return j.promptId
            }),
          ),
        ]
        const isFullyJudged = judgedPromptIds.length === promptIds.length

        return {
          id: article.articleId,
          articleTitle: article.articleTitle,
          articleCreatedAt: article.articleCreatedAt,
          articleUpdatedAt: article.articleUpdatedAt,
          judgments: sorted,
          judgedPromptIds,
          isFullyJudged,
        }
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

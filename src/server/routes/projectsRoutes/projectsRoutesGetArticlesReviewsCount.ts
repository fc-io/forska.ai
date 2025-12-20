import {and, asc, gt, type SQL} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {
  buildProgressiveFetchContext,
  fetchProjectMetadata,
  isInScope,
  passesAnswerFilters,
} from './articlesReviewsQueryBuilder.ts'

/**
 * Progressive count endpoint for articles reviews.
 *
 * Uses the same progressive fetch approach as the data endpoint,
 * but counts all matching articles instead of stopping at a page limit.
 *
 * Why this is faster than GROUP BY:
 * - Uses fast index scan (~50ms per 2000 rows)
 * - Scope filtering in memory avoids slow OR/subquery
 * - Memory-efficient: only counts, doesn't store full data
 */
export const projectsRoutesGetArticlesReviewsCount = new Elysia().post(
  '/api/articlesreviewscount',
  async ({body}) => {
    try {
      const db = getDatabase()

      const limit = parseInt(body?.limit ?? '100', 10)

      // === PARALLEL METADATA QUERIES ===
      console.time('count: metadata')
      const metadata = await fetchProjectMetadata(db, body.projectId)
      console.timeEnd('count: metadata')

      if (metadata.projectPromptRows.length === 0) {
        return {totalCount: 0, totalPages: 0}
      }

      // === BUILD QUERY CONTEXT ===
      console.time('count: context')
      const context = buildProgressiveFetchContext(
        {projectId: body.projectId, from: body.from, to: body.to, search: body.search, prompts: body.prompts},
        metadata,
      )
      console.timeEnd('count: context')

      if (!context) {
        return {totalCount: 0, totalPages: 0}
      }

      const {promptIds, whereCondition, answerFilters, scopeFilter} = context

      // === PROGRESSIVE COUNT ===
      // Same approach as data endpoint, but count ALL matching articles
      console.time('count: progressive count')

      const BATCH_SIZE = 2000 // Same as data endpoint
      const MAX_ITERATIONS = 500 // Higher limit since we need to count all

      // Type for judgment row from the database
      type JudgmentRow = typeof judgments.$inferSelect

      // Track which articles we've already counted
      const countedArticleIds = new Set<string>()
      let cursor: string | null = null
      let iterations = 0
      let noMoreData = false

      while (iterations < MAX_ITERATIONS && !noMoreData) {
        iterations++

        // Build WHERE condition with cursor
        const cursorCondition: SQL | undefined = cursor ? gt(judgments.articleId, cursor) : undefined
        const batchWhere: SQL = cursorCondition
          ? (and(whereCondition, cursorCondition) ?? whereCondition)
          : whereCondition

        // Fetch batch using index scan
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

        // Apply scope and answer filters, count matching articles
        for (const [articleId, articleJudgments] of grouped) {
          // Skip if already counted
          if (countedArticleIds.has(articleId)) {
            continue
          }

          // Check if article is in scope
          const inScopeJudgments = articleJudgments.filter((j) => {
            return isInScope(j, scopeFilter)
          })

          if (inScopeJudgments.length === 0) {
            continue
          }

          // Check if article passes answer filters
          if (!passesAnswerFilters(inScopeJudgments, answerFilters)) {
            continue
          }

          // Check if article has judgments for the project's prompts
          const hasRelevantJudgments = inScopeJudgments.some((j) => {
            return promptIds.includes(j.promptId)
          })

          if (hasRelevantJudgments) {
            countedArticleIds.add(articleId)
          }
        }

        // Update cursor to last article_id we saw
        const lastRow = batch[batch.length - 1]
        if (lastRow) {
          cursor = lastRow.judgment.articleId
        }
      }

      console.timeEnd('count: progressive count')

      const totalCount = countedArticleIds.size
      const totalPages = Math.ceil(totalCount / limit)

      console.log(`📊 Progressive count: ${iterations} batches, ${totalCount} articles total`)

      return {totalCount, totalPages}
    } catch (error) {
      console.error('Error fetching articles reviews count:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews count')
    }
  },
  {
    body: t.Object({
      from: t.Optional(t.String()),
      limit: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)

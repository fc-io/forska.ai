import {and, asc, gt, inArray, type SQL} from 'drizzle-orm'
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
 * 3. Apply scope + answer filters in memory
 * 4. Cursor-based pagination using article_id for stability
 *
 * Two-phase approach for sparse-scope projects:
 * - Phase 1: Get in-scope article IDs (from curated + import routes)
 * - Phase 2: Fetch judgments only for in-scope articles (uses IN clause)
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

      const {promptIds, promptOrderMap, whereCondition, answerFilters, scopeFilter} = context

      // === DETERMINE SCOPE STRATEGY ===
      // If we have curated articles, we know the exact article IDs upfront
      // This is much faster than filtering all judgments in memory
      const hasCuratedArticles = scopeFilter.curatedArticleIds.size > 0
      const hasImportRoutes = scopeFilter.routeTexts.length > 0

      console.time('progressive fetch')

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

      if (hasCuratedArticles && !hasImportRoutes) {
        // === FAST PATH: Curated articles only ===
        // We know all article IDs upfront - fetch directly with IN clause
        console.log(`⚡ Fast path: ${scopeFilter.curatedArticleIds.size} curated articles`)

        const curatedIds = [...scopeFilter.curatedArticleIds]
        const BATCH_SIZE = 100 // Process in batches of article IDs
        const ARTICLES_NEEDED = page * limit

        for (let i = 0; i < curatedIds.length && matchingArticles.length < ARTICLES_NEEDED; i += BATCH_SIZE) {
          const batchIds = curatedIds.slice(i, i + BATCH_SIZE)

          // Fetch judgments for this batch of articles
          const judgmentRows = await db
            .select({judgment: judgments})
            .from(judgments)
            .where(and(whereCondition, inArray(judgments.articleId, batchIds)))

          // Group by article
          const grouped = new Map<string, JudgmentRow[]>()
          for (const row of judgmentRows) {
            const existing = grouped.get(row.judgment.articleId) ?? []
            existing.push(row.judgment)
            grouped.set(row.judgment.articleId, existing)
          }

          // Apply answer filters
          for (const [articleId, articleJudgments] of grouped) {
            if (!passesAnswerFilters(articleJudgments, answerFilters)) {
              continue
            }

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
      } else {
        // === GENERAL PATH: Import routes and/or curated ===
        // Need to scan through judgments and filter by scope in memory
        const BATCH_SIZE = 2000
        const MAX_ITERATIONS = 100
        const ARTICLES_NEEDED = page * limit

        let cursor: string | null = null
        let iterations = 0
        let noMoreData = false

        while (matchingArticles.length < ARTICLES_NEEDED && iterations < MAX_ITERATIONS && !noMoreData) {
          iterations++

          const cursorCondition: SQL | undefined = cursor ? gt(judgments.articleId, cursor) : undefined
          const batchWhere: SQL = cursorCondition
            ? (and(whereCondition, cursorCondition) ?? whereCondition)
            : whereCondition

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

          // Apply scope and answer filters
          for (const [articleId, articleJudgments] of grouped) {
            // Check scope: import route match OR curated article
            const firstJudgment = articleJudgments[0]
            const isInScope =
              (firstJudgment?.articleImportRoute && scopeFilter.routeTexts.includes(firstJudgment.articleImportRoute))
              || scopeFilter.curatedArticleIds.has(articleId)

            if (!isInScope) {
              continue
            }

            if (!passesAnswerFilters(articleJudgments, answerFilters)) {
              continue
            }

            const relevantJudgments = articleJudgments.filter((j) => {
              return promptIds.includes(j.promptId)
            })

            if (relevantJudgments.length > 0) {
              matchingArticles.push({
                articleId,
                judgments: relevantJudgments,
                articleTitle: firstJudgment?.articleTitle ?? null,
                articleCreatedAt: firstJudgment?.articleCreatedAt ?? null,
                articleUpdatedAt: firstJudgment?.articleUpdatedAt ?? null,
              })
            }
          }

          const lastRow = batch[batch.length - 1]
          if (lastRow) {
            cursor = lastRow.judgment.articleId
          }
        }

        console.log(`🔄 Progressive fetch: ${iterations} batches`)
      }

      console.timeEnd('progressive fetch')
      console.log(`📄 Found ${matchingArticles.length} articles for page ${page}`)

      // === PAGINATION ===
      const startIndex = (page - 1) * limit
      const pageArticles = matchingArticles.slice(startIndex, startIndex + limit)

      // === BUILD RESULT ===
      console.time('result processing')
      const result = pageArticles.map((article) => {
        const sorted = [...article.judgments].sort((a, b) => {
          const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
          const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
          return ao - bo
        })

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

import {sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {buildArticlesReviewsQueryContext, fetchProjectMetadata} from './articlesReviewsQueryBuilder.ts'

/**
 * Separate count endpoint for articles reviews.
 * This is split from the main data endpoint because the count query
 * can be slow (~60s) and shouldn't block the initial data load.
 *
 * The frontend can call this endpoint in parallel with the data endpoint
 * and update the pagination UI when the count arrives.
 */
export const projectsRoutesGetArticlesReviewsCount = new Elysia().post(
  '/api/articlesreviewscount',
  async ({body}) => {
    try {
      const db = getDatabase()

      const limit = parseInt(body?.limit || '100', 10)

      // Fetch project metadata
      console.time('count: metadata queries')
      const metadata = await fetchProjectMetadata(db, body.projectId)
      console.timeEnd('count: metadata queries')

      if (metadata.projectPromptRows.length === 0) {
        return {totalCount: 0, totalPages: 0}
      }

      // Build query context
      console.time('count: query preparation')
      const queryContext = buildArticlesReviewsQueryContext(
        {projectId: body.projectId, from: body.from, to: body.to, search: body.search, prompts: body.prompts},
        metadata,
      )
      console.timeEnd('count: query preparation')

      if (!queryContext) {
        return {totalCount: 0, totalPages: 0}
      }

      const {combinedWhereCondition, havingCondition} = queryContext

      // Execute count query
      console.time('count: count query')

      // Use sql`1=1` as a no-op HAVING when no answer filters exist
      const effectiveHaving = havingCondition ?? sql`1=1`

      const groupedBase = db
        .select({articleId: judgments.articleId})
        .from(judgments)
        .where(combinedWhereCondition)
        .groupBy(judgments.articleId)
        .having(effectiveHaving)
        .as('grouped_articles')

      const [{count: totalCount = 0} = {count: 0}] = await db.select({count: sql<number>`COUNT(*)`}).from(groupedBase)
      console.timeEnd('count: count query')

      return {totalCount, totalPages: Math.ceil(totalCount / limit)}
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

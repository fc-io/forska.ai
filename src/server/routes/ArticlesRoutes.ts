import {count, desc, eq, isNull} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {articles, judgments} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const articlesRoutes = new Elysia()
  .get('/api/unassessed-count', async () => {
    try {
      const db = getDatabase()
      const result = await db
        .select({count: count()})
        .from(articles)
        .leftJoin(judgments, eq(articles.id, judgments.articleId))
        .where(isNull(judgments.id))

      return {count: result[0]?.count || 0}
    } catch (error) {
      console.error('Error fetching unassessed count:', error)
      return {count: null, error: 'Failed to fetch unassessed count'}
    }
  })
  .get('/api/articles/latest', async () => {
    try {
      const db = getDatabase()

      // Fetch articles with their latest judgments
      const result = await db
        .select({
          id: articles.id,
          article_id: articles.articleId,
          article_title: articles.articleTitle,
          article_authors: articles.articleAuthors,
          article_created: articles.articleCreatedAt,
          // We'll need to aggregate judgments in a subquery or join
          // For now, returning article data
        })
        .from(articles)
        .leftJoin(judgments, eq(articles.id, judgments.articleId))
        .orderBy(desc(articles.createdAt))
        .limit(200)

      // Transform the data to match the expected format
      const transformedData = result.map((row) => {
        return {
          id: row.id,
          article_id: row.article_id || '',
          article_title: row.article_title,
          article_authors: row.article_authors?.join(', ') || '',
          article_created: row.article_created?.toISOString() || '',
          // These fields would come from judgments - setting defaults for now
          article_judged_as_ai: 'undecided' as const,
          article_judged_as_ai_agent: 'undecided' as const,
          article_judged_as_healthcare: 'undecided' as const,
        }
      })

      return {data: transformedData}
    } catch (error) {
      console.error('Error fetching latest articles:', error)
      return {data: [], error: 'Failed to fetch latest articles'}
    }
  })

import {count, desc, eq, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

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
  .post(
    '/api/articles/batch-upsert',
    async ({body}) => {
      try {
        const db = getDatabase()
        const {entries} = body

        const articlesToUpsert = entries.map((entry) => {
          return {
            articleId: entry.article_id,
            articleTitle: entry.article_title,
            articleSummary: entry.article_summary,
            articleAuthors: entry.article_authors,
            articleUpdatedAt: new Date(entry.article_updated_at),
            articleCreatedAt: new Date(entry.article_created_at),
            articleVersion: parseInt(entry.article_version),
            arxivId: entry.arxiv_id,
          }
        })

        await db
          .insert(articles)
          .values(articlesToUpsert)
          .onConflictDoUpdate({
            target: articles.articleId,
            set: {
              articleTitle: sql`EXCLUDED.article_title`,
              articleSummary: sql`EXCLUDED.article_summary`,
              articleAuthors: sql`EXCLUDED.article_authors`,
              articleUpdatedAt: sql`EXCLUDED.article_updated_at`,
              articleVersion: sql`EXCLUDED.article_version`,
              arxivId: sql`EXCLUDED.arxiv_id`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          })

        return {success: true, count: entries.length}
      } catch (error) {
        console.error('Error upserting articles:', error)
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to upsert articles',
        }
      }
    },
    {
      body: t.Object({
        entries: t.Array(
          t.Object({
            article_id: t.String(),
            article_title: t.String(),
            article_summary: t.String(),
            article_authors: t.Array(t.String()),
            article_updated_at: t.String(),
            article_created_at: t.String(),
            article_version: t.String(),
            arxiv_id: t.String(),
          }),
        ),
      }),
    },
  )

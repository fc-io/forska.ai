import {count, eq, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const articlesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/unassessed-count', async () => {
    const db = getDatabase()
    const result = await db
      .select({count: count()})
      .from(articles)
      .leftJoin(judgments, eq(articles.id, judgments.articleId))
      .where(isNull(judgments.id))

    return {count: result[0]?.count || 0}
  })
  .get('/api/articles/stats', async () => {
    const db = getDatabase()

    const [totalRow] = await db.select({count: count()}).from(articles)

    const byRoute = await db
      .select({importRoute: articles.importRoute, count: count()})
      .from(articles)
      .groupBy(articles.importRoute)

    return {total: totalRow?.count ?? 0, byImportRoute: byRoute}
  })
  .get('/api/articles/latest', async () => {
    const db = getDatabase()

    // Fetch articles with their latest judgments
    const data = await db
      .select({
        id: articles.id,
        articleId: articles.articleId,
        articleTitle: articles.articleTitle,
        articleAuthors: articles.articleAuthors,
        articleCreatedAt: articles.articleCreatedAt,
        // We'll need to aggregate judgments in a subquery or join
        // For now, returning article data
      })
      .from(articles)
      .orderBy(
        sql`COALESCE(${articles.articleCreatedAt}, ${articles.createdAt}) DESC, ${articles.createdAt} DESC, ${articles.id} DESC`,
      )
      .limit(200)

    return {data}
  })
  .post(
    '/api/articles/batch-upsert',
    async ({body}) => {
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
          pubmedId: entry.pubmed_id,
          importRoute: entry.import_route,
          originalData: entry.original_data,
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
            pubmedId: sql`EXCLUDED.pubmed_id`,
            importRoute: sql`EXCLUDED.import_route`,
            originalData: sql`EXCLUDED.original_data`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
        })

      return {success: true, count: entries.length}
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
            arxiv_id: t.Optional(t.String()),
            pubmed_id: t.Optional(t.String()),
            import_route: t.String(),
            original_data: t.Optional(t.Any()),
          }),
        ),
      }),
    },
  )

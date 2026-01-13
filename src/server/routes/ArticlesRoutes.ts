import {count, desc, eq, inArray, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  importRoute as importRouteTable,
  judgments,
  models,
  projects,
  prompts,
} from '../../db/schema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const articlesRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
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

    // Count by linked import routes (via article_route_link)
    const linkedCounts = await db
      .select({importRoute: importRouteTable.route, count: count()})
      .from(articles)
      .innerJoin(articleRouteLink, eq(articleRouteLink.articleId, articles.id))
      .innerJoin(importRouteTable, eq(importRouteTable.id, articleRouteLink.importRouteId))
      .groupBy(importRouteTable.route)

    // Count articles with NO import_route link via NOT EXISTS
    const [{count: withoutImportRoute = 0} = {count: 0}] = await db
      .select({count: sql<number>`COUNT(*)`.as('count')})
      .from(articles).where(sql`NOT EXISTS (
        ${db
          .select({exists: sql`1`})
          .from(articleRouteLink)
          .where(eq(articleRouteLink.articleId, articles.id))
          .limit(1)}
      )`)

    // Return totals (overall, by route, and without a link)
    return {total: totalRow?.count ?? 0, byImportRoute: linkedCounts, withoutImportRoute}
  })
  .get('/api/articles/conversion-stats', async () => {
    const db = getDatabase()

    const [totalFailedRow] = await db
      .select({count: count()})
      .from(articles)
      .where(eq(articles.fullTextConversionStatus, 'failed'))

    const lastFailed = await db
      .select({
        id: articles.id,
        articleId: articles.articleId,
        title: articles.articleTitle,
        error: articles.fullTextConversionError,
        attempts: articles.fullTextConversionAttempts,
        updatedAt: articles.updatedAt,
      })
      .from(articles)
      .where(eq(articles.fullTextConversionStatus, 'failed'))
      .orderBy(desc(articles.updatedAt))
      .limit(10)

    return {lastFailed, totalFailed: totalFailedRow?.count ?? 0}
  })
  .post('/api/articles/conversion-reset', async () => {
    const db = getDatabase()

    await db
      .update(articles)
      .set({fullTextConversionStatus: null, fullTextConversionAttempts: 0, fullTextConversionError: null})
      .where(eq(articles.fullTextConversionStatus, 'failed'))

    return {success: true}
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
          originalData: entry.original_data as unknown,
        }
      })

      const inserted = await db
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
            originalData: sql`EXCLUDED.original_data`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
        })
        .returning({id: articles.id, articleId: articles.articleId})

      // Link articles to import routes in article_route_link
      const articleIds = inserted.map((r) => {
        return r.articleId
      })

      const articleIdToRoute = new Map(
        entries.map((e) => {
          return [e.article_id, e.import_route]
        }),
      )
      const routeList = Array.from(
        new Set(
          entries
            .map((e) => {
              return e.import_route
            })
            .filter(Boolean),
        ),
      )

      if (routeList.length > 0 && articleIds.length > 0) {
        const importRoutes = await db
          .select({id: importRouteTable.id, route: importRouteTable.route})
          .from(importRouteTable)
          .where(inArray(importRouteTable.route, routeList))

        const routeMap = new Map(
          importRoutes.map((r) => {
            return [r.route, r.id]
          }),
        )

        const links = inserted
          .map((a) => {
            const route = articleIdToRoute.get(a.articleId)
            const importRouteId = route ? routeMap.get(route) : undefined
            return importRouteId ? {articleId: a.id, importRouteId} : null
          })
          .filter((v): v is {articleId: string; importRouteId: string} => {
            return v !== null
          })

        if (links.length > 0) {
          await db.insert(articleRouteLink).values(links).onConflictDoNothing()
        }
      }

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
  .get(
    '/api/articles/search',
    async ({query}) => {
      const db = getDatabase()
      const {q} = query

      if (!q || q.trim() === '') {
        return {data: []}
      }

      const searchTerm = q.trim()
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(searchTerm)

      const whereClause = isUuid
        ? sql`${articles.id} = ${searchTerm} OR ${articles.articleId} = ${searchTerm} OR ${articles.articleTitle} ILIKE ${'%' + searchTerm + '%'}`
        : sql`${articles.articleId} = ${searchTerm} OR ${articles.articleTitle} ILIKE ${'%' + searchTerm + '%'}`

      const searchResults = await db
        .select()
        .from(articles)
        .where(whereClause)
        .orderBy(
          sql`
          CASE
            WHEN ${isUuid ? sql`${articles.id} = ${searchTerm}` : sql`FALSE`} THEN 0
            WHEN ${articles.articleId} = ${searchTerm} THEN 1
            ELSE 2
          END,
          ${articles.articleTitle} ASC
        `,
        )
        .limit(50)

      return {data: searchResults}
    },
    {query: t.Object({q: t.String()})},
  )
  .get(
    '/api/articles/:id',
    async ({params}) => {
      const db = getDatabase()
      const {id} = params

      // Get the article
      const [article] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      // Get all judgments for this article (Cross-Project / Admin View)
      const allArticleJudgments = await db
        .select({judgment: judgments, prompt: prompts, modelName: models.modelName})
        .from(judgments)
        .innerJoin(prompts, eq(judgments.promptId, prompts.id))
        .leftJoin(models, eq(judgments.modelId, models.id))
        .where(eq(judgments.articleId, id))

      const allJudgments = allArticleJudgments.map(({judgment, prompt, modelName}) => {
        return {...judgment, prompt, modelName}
      })

      // Resolve project names for snapshotProjectId when present
      const snapshotProjectIds = Array.from(
        new Set(
          allJudgments
            .map((j) => {
              return j.snapshotProjectId
            })
            .filter((id): id is string => {
              return Boolean(id)
            }),
        ),
      )
      const projectNameRows =
        snapshotProjectIds.length > 0
          ? await db
              .select({id: projects.id, name: projects.name})
              .from(projects)
              .where(inArray(projects.id, snapshotProjectIds))
          : []
      const projectsById = projectNameRows.reduce<Record<string, {name: string}>>((acc, row) => {
        acc[row.id] = {name: row.name}
        return acc
      }, {})

      return {article, allJudgments, projectsById}
    },
    {params: t.Object({id: t.String()})},
  )

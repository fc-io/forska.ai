import {and, desc, eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, projectArticles} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'

export const projectArticlesRoutes = new Elysia()
  .get(
    '/api/projects/:id/articles',
    async ({params, query}) => {
      const db = getDatabase()
      const {id: projectId} = params
      const page = parseInt(query.page || '1', 10)
      const limit = parseInt(query.limit || '50', 10)
      const offset = (page - 1) * limit

      const totalCountResult = await db
        .select({count: sql<number>`COUNT(*)`.as('count')})
        .from(projectArticles)
        .where(eq(projectArticles.projectId, projectId))

      const totalCount = totalCountResult?.[0]?.count ?? 0

      const rows = await db
        .select({id: articles.id, articleTitle: articles.articleTitle})
        .from(projectArticles)
        .innerJoin(articles, eq(projectArticles.articleId, articles.id))
        .where(eq(projectArticles.projectId, projectId))
        .orderBy(desc(articles.createdAt), desc(articles.id))
        .limit(limit)
        .offset(offset)

      return {
        articles: rows,
        totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      }
    },
    {
      params: t.Object({id: t.String()}),
      query: t.Object({page: t.Optional(t.String()), limit: t.Optional(t.String())}),
    },
  )
  .post(
    '/api/projects/:id/articles',
    async ({params, body}) => {
      const projectId = params.id
      const articleIds = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]

      const result = await insertArticlesIntoProject(projectId, articleIds)
      return {success: true, ...result}
    },
    {body: t.Object({articleIds: t.Union([t.String(), t.Array(t.String())])})},
  )
  .delete('/api/projects/:id/articles/:articleId', async ({params}) => {
    const db = getDatabase()
    const {id: projectId, articleId} = params

    await db
      .delete(projectArticles)
      .where(and(eq(projectArticles.projectId, projectId), eq(projectArticles.articleId, articleId)))

    return {success: true}
  })

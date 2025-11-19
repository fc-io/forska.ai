import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, projectArticles} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'

export const projectArticlesRoutes = new Elysia()
  .get('/api/projects/:id/articles', async ({params}) => {
    const db = getDatabase()
    const {id: projectId} = params

    const rows = await db
      .select({id: articles.id, articleTitle: articles.articleTitle})
      .from(projectArticles)
      .innerJoin(articles, eq(projectArticles.articleId, articles.id))
      .where(eq(projectArticles.projectId, projectId))

    return {articles: rows}
  })
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

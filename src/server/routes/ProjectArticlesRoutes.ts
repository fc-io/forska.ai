import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {projectArticles} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'

export const projectArticlesRoutes = new Elysia()
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

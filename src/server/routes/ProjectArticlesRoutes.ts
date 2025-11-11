import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {projectArticleLink} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const projectArticlesRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/project-articles',
    async ({body}) => {
      const db = getDatabase()
      const {projectId, articleId} = body
      const [row] = await db
        .insert(projectArticleLink)
        .values({projectId, articleId})
        .onConflictDoNothing()
        .returning()
      return {data: row ?? null}
    },
    {body: t.Object({projectId: t.String(), articleId: t.String()})},
  )
  .delete(
    '/api/project-articles',
    async ({body}) => {
      const db = getDatabase()
      const {projectId, articleId} = body
      const result = await db
        .delete(projectArticleLink)
        .where(and(eq(projectArticleLink.projectId, projectId), eq(projectArticleLink.articleId, articleId)))
        .returning({id: projectArticleLink.id})
      return {success: result.length > 0}
    },
    {body: t.Object({projectId: t.String(), articleId: t.String()})},
  )

import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString} from '../services/appQueryHelpers.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'
import {getProjectMartRefreshStateService} from '../services/projectMartRefreshStateService.ts'

export const projectArticlesRoutes = new Elysia()
  .get(
    '/api/projects/:id/articles',
    async ({params, query}) => {
      const {id: projectId} = params
      const page = parseInt(query.page || '1', 10)
      const limit = parseInt(query.limit || '10', 10)
      const offset = (page - 1) * limit

      const [[countRow], rows] = await Promise.all([
        getAppDatabaseService().queryJson<{count: number}>(`
          SELECT COUNT(*) AS count
          FROM app.project_article
          WHERE project_id = '${escapeSqlString(projectId)}'
        `),
        getAppDatabaseService().queryJson<{
          id: string
          articleTitle: string
          importedFromProjectId: string | null
          importedFromProjectName: string | null
        }>(`
          SELECT
            a.id AS id,
            a.article_title AS articleTitle,
            pa.imported_from_project_id AS importedFromProjectId,
            p.name AS importedFromProjectName
          FROM app.project_article pa
          INNER JOIN app.article a ON pa.article_id = a.id
          LEFT JOIN app.project p ON pa.imported_from_project_id = p.id
          WHERE pa.project_id = '${escapeSqlString(projectId)}'
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `),
      ])

      const totalCount = countRow?.count ?? 0

      return {articles: rows, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
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
      const importedFromProjectId = body.importedFromProjectId ?? null

      const result = await insertArticlesIntoProject(projectId, articleIds, importedFromProjectId)
      return {success: true, ...result}
    },
    {
      body: t.Object({
        articleIds: t.Union([t.String(), t.Array(t.String())]),
        importedFromProjectId: t.Optional(t.String()),
      }),
    },
  )
  .delete('/api/projects/:id/articles/:articleId', async ({params}) => {
    const {id: projectId, articleId} = params

    await getAppDatabaseService().transaction(async (tx) => {
      const [existingProjectArticle] = await tx.queryJson<{articleId: string}>(`
        SELECT article_id AS articleId
        FROM app.project_article
        WHERE project_id = '${escapeSqlString(projectId)}'
          AND article_id = '${escapeSqlString(articleId)}'
        LIMIT 1
      `)

      if (!existingProjectArticle) {
        return
      }

      await tx.run(`
        DELETE FROM app.project_article
        WHERE project_id = '${escapeSqlString(projectId)}'
          AND article_id = '${escapeSqlString(articleId)}'
      `)

      await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
        projects: [{articleIds: [articleId], projectId}],
        reason: 'ProjectArticlesRoutes.delete',
        runner: tx,
      })
    })

    return {success: true}
  })

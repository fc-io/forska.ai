import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'

export const articlesRoutesDeleteArticle = async ({params}: {params: {id: string}}) => {
  const {id} = params

  const [article] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

  if (!article) {
    throw new Error('Article not found')
  }

  const [judgmentRow] = await getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM app.judgment
        WHERE article_id = '${escapeSqlString(id)}'
      `)

  const judgmentCount = judgmentRow?.count ?? 0
  if (judgmentCount > 0) {
    throw new Error(`Cannot delete article with ${judgmentCount} judgments`)
  }

  await getAppDatabaseService().run(`
        DELETE FROM app.article
        WHERE id = '${escapeSqlString(id)}'
      `)
  return {success: true, id}
}

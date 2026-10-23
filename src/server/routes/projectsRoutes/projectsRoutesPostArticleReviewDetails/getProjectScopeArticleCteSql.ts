import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'

export const getProjectScopeArticleCteSql = (params: {articleId: string; projectId: string}) => {
  return `
    project_scope_article AS (
      SELECT pir.project_id, air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = ${getSqlLiteral(params.projectId)}
        AND air.article_id = ${getSqlLiteral(params.articleId)}
      UNION
      SELECT pa.project_id, pa.article_id
      FROM app.project_article pa
      WHERE pa.project_id = ${getSqlLiteral(params.projectId)}
        AND pa.article_id = ${getSqlLiteral(params.articleId)}
    )
  `
}

import {escapeSqlString} from './appQueryHelpers.ts'

export const getProjectScopeMartArticleCountSql = (projectId: string): string => {
  return `
    SELECT CAST(COUNT(DISTINCT scope.article_id) AS INTEGER) AS totalArticleCount
    FROM mart.project_scope_article scope
    WHERE scope.project_id = '${escapeSqlString(projectId)}'
      AND (scope.in_curated_scope OR scope.in_route_scope)
  `
}

export const getProjectScopeMartArticleSql = (projectId: string): string => {
  return `
    SELECT DISTINCT scope.article_id AS articleId
    FROM mart.project_scope_article scope
    WHERE scope.project_id = '${escapeSqlString(projectId)}'
      AND (scope.in_curated_scope OR scope.in_route_scope)
  `
}

export const getProjectScopeTableArticleSql = (projectId: string): string => {
  return `
    SELECT pa.article_id AS articleId
    FROM app.project_article pa
    INNER JOIN app.project p ON p.id = pa.project_id
    INNER JOIN app.article a ON a.id = pa.article_id
    WHERE pa.project_id = '${escapeSqlString(projectId)}'
      AND (p.date_from IS NULL OR a.article_created_at >= p.date_from)
      AND (p.date_to IS NULL OR a.article_created_at <= p.date_to)
    UNION ALL
    SELECT air.article_id AS articleId
    FROM app.project_import_route pir
    INNER JOIN app.project p ON p.id = pir.project_id
    INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
    INNER JOIN app.article a ON a.id = air.article_id
    WHERE pir.project_id = '${escapeSqlString(projectId)}'
      AND (p.date_from IS NULL OR a.article_created_at >= p.date_from)
      AND (p.date_to IS NULL OR a.article_created_at <= p.date_to)
  `
}

import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'

export const getProjectArticleWhereClause = (params: {
  projectId: string
  routeIds: string[]
  dateFrom: Date | null
  dateTo: Date | null
}) => {
  return appQueryHelpers.getAndClause([
    appQueryHelpers.getProjectScopeClause({
      articleAlias: 'a',
      importRouteIds: params.routeIds,
      projectId: params.projectId,
    }),
    params.dateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(params.dateFrom)}` : null,
    params.dateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(params.dateTo)}` : null,
  ])
}

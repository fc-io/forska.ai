import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {idTitleKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {getInClause} from './comparisonProjectConflictResolutionImportSql.ts'

export const getComparisonProjectConflictResolutionImportTitleKeySql = (column: string) => {
  return `regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '\\s+', ' ', 'g')`
}

export const getComparisonProjectConflictResolutionImportIdTitleKeySql = (params: {
  externalArticleIdColumn: string
  titleColumn: string
}) => {
  return `LOWER(TRIM(COALESCE(${params.externalArticleIdColumn}, ''))) || ${getSqlLiteral(idTitleKeySeparator)} || ${getComparisonProjectConflictResolutionImportTitleKeySql(params.titleColumn)}`
}

export type ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams = {
  articleImportRouteTable?: string
  externalArticleImportRouteIds?: readonly string[]
}

const hasComparisonProjectConflictResolutionImportScopedExternalArticleSql = (
  params: ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  return Boolean(params.articleImportRouteTable && params.externalArticleImportRouteIds?.length)
}

export const getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql = (
  params: ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  if (!hasComparisonProjectConflictResolutionImportScopedExternalArticleSql(params)) {
    return null
  }
  const importRouteIds = params.externalArticleImportRouteIds ?? []

  return `
    scoped_external_article AS (
      SELECT
        article_id AS articleId,
        MIN(external_article_id) AS externalArticleId
      FROM ${params.articleImportRouteTable}
      WHERE import_route_id IN (${getInClause([...importRouteIds])})
        AND NULLIF(TRIM(COALESCE(external_article_id, '')), '') IS NOT NULL
      GROUP BY article_id
    )`
}

export const getComparisonProjectConflictResolutionImportWithCtesSql = (ctes: Array<string | null | undefined>) => {
  const filteredCtes = ctes.filter((cte): cte is string => {
    return Boolean(cte)
  })

  return filteredCtes.length > 0 ? `WITH ${filteredCtes.join(',\n')}` : ''
}

export const getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql = (
  params: ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  return hasComparisonProjectConflictResolutionImportScopedExternalArticleSql(params)
    ? 'COALESCE(scoped_external_article.externalArticleId, a.article_id)'
    : 'a.article_id'
}

export const getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql = (
  params: ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  return hasComparisonProjectConflictResolutionImportScopedExternalArticleSql(params)
    ? 'LEFT JOIN scoped_external_article ON scoped_external_article.articleId = a.id'
    : ''
}

export const getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql = (
  params: ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  return hasComparisonProjectConflictResolutionImportScopedExternalArticleSql(params)
    ? 'a.article_id, scoped_external_article.externalArticleId'
    : 'a.article_id'
}

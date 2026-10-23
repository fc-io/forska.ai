import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {articleImportRouteTable} from './comparisonProjectRouteConstants.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'
import {isDefined} from './comparisonProjectValueHelpers.ts'

const projectArticleTable = 'app.project_article'

const getCaseInsensitiveContainsClause = (column: string, searchValue: string) => {
  return `LOWER(COALESCE(${column}, '')) LIKE LOWER(${getSqlLiteral(`%${searchValue}%`)})`
}

const getArticleMatchesImportRouteClause = (articleAlias: string, routeIds: string[]) => {
  return routeIds.length === 0
    ? null
    : `EXISTS (
        SELECT 1
        FROM ${articleImportRouteTable} air
        WHERE air.article_id = ${articleAlias}.id
          AND air.import_route_id IN (${getInClause(routeIds)})
      )`
}

const getArticleMatchesProjectClause = (articleAlias: string, projectIds: string[]) => {
  return projectIds.length === 0
    ? null
    : `EXISTS (
        SELECT 1
        FROM ${projectArticleTable} pa
        WHERE pa.article_id = ${articleAlias}.id
          AND pa.project_id IN (${getInClause(projectIds)})
      )`
}

const getArticleInScopeClause = (
  articleAlias: string,
  routeIds: string[],
  projectIds: string[],
  useImportRoutesForScope: boolean,
) => {
  const importRouteClause = useImportRoutesForScope ? getArticleMatchesImportRouteClause(articleAlias, routeIds) : null
  const projectClause = getArticleMatchesProjectClause(articleAlias, projectIds)
  return importRouteClause && projectClause
    ? `(${importRouteClause} OR ${projectClause})`
    : (importRouteClause ?? projectClause)
}

export const getArticleScopeConditions = (
  routeIds: string[],
  sourceProjectIds: string[],
  useImportRoutesForScope: boolean,
  searchTitle?: string | null,
) => {
  const trimmedSearchTitle = searchTitle?.trim() ?? ''
  const scopeCondition = getArticleInScopeClause('a', routeIds, sourceProjectIds, useImportRoutesForScope)

  return [
    scopeCondition,
    trimmedSearchTitle ? getCaseInsensitiveContainsClause('a.article_title', trimmedSearchTitle) : null,
  ].filter(isDefined)
}

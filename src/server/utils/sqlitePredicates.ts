import {type AnyColumn, or, type SQL, sql, type SQLWrapper} from 'drizzle-orm'

import {articleRouteLink, projectArticles} from '../../db/schema.ts'

const getSqliteTextValueChunks = (values: string[]) => {
  return sql.join(
    values.map((value) => {
      return sql`${value}`
    }),
    sql`, `,
  )
}

export const getSqliteTextValuesSql = (values: string[]) => {
  return values.length > 0 ? getSqliteTextValueChunks(values) : null
}

export const getArticleMatchesImportRouteCondition = (
  articleIdColumn: SQLWrapper | AnyColumn,
  routeIds: string[],
): SQL<unknown> | null => {
  const routeValues = getSqliteTextValuesSql(routeIds)

  return routeValues
    ? sql`EXISTS (
        SELECT 1 FROM ${articleRouteLink} arl
        WHERE arl."article_id" = ${articleIdColumn}
          AND arl."import_route_id" IN (${routeValues})
      )`
    : null
}

export const getArticleMatchesProjectCondition = (
  articleIdColumn: SQLWrapper | AnyColumn,
  projectId: string,
): SQL<unknown> => {
  return sql`EXISTS (
    SELECT 1 FROM ${projectArticles} pa
    WHERE pa."article_id" = ${articleIdColumn}
      AND pa."project_id" = ${projectId}
  )`
}

export const getArticleInScopeCondition = (
  articleIdColumn: SQLWrapper | AnyColumn,
  routeIds: string[],
  projectId: string | null,
): SQL<unknown> | null => {
  const importRouteCondition = getArticleMatchesImportRouteCondition(articleIdColumn, routeIds)
  const projectCondition = projectId ? getArticleMatchesProjectCondition(articleIdColumn, projectId) : null
  const combinedCondition = or(importRouteCondition ?? undefined, projectCondition ?? undefined)

  return importRouteCondition && projectCondition
    ? (combinedCondition ?? null)
    : (importRouteCondition ?? projectCondition ?? null)
}

export const getCaseInsensitiveContains = (column: SQLWrapper | AnyColumn, searchValue: string): SQL<unknown> => {
  const pattern = `%${searchValue}%`
  return sql`LOWER(COALESCE(${column}, '')) LIKE LOWER(${pattern})`
}

export const getTrimmedTextExistsCondition = (column: SQLWrapper | AnyColumn): SQL<unknown> => {
  return sql`NULLIF(TRIM(COALESCE(${column}, '')), '') IS NOT NULL`
}

export const getJsonArrayTextExistsCondition = (column: SQLWrapper | AnyColumn): SQL<unknown> => {
  return sql`EXISTS (
    SELECT 1
    FROM json_each(COALESCE(${column}, json_array())) answer_value
    WHERE NULLIF(TRIM(COALESCE(answer_value.value, '')), '') IS NOT NULL
  )`
}

export const getAnswerExistsCondition = (
  answerColumn: SQLWrapper | AnyColumn,
  answerArrayColumn: SQLWrapper | AnyColumn,
): SQL<unknown> => {
  return sql`(${getTrimmedTextExistsCondition(answerColumn)} OR ${getJsonArrayTextExistsCondition(answerArrayColumn)})`
}

export const getJoinedJsonArrayText = (column: SQLWrapper | AnyColumn): SQL<unknown> => {
  return sql`(
    SELECT group_concat(answer_value.value, char(10))
    FROM json_each(COALESCE(${column}, json_array())) answer_value
  )`
}

export const getNormalizedAnswerText = (
  answerColumn: SQLWrapper | AnyColumn,
  answerArrayColumn: SQLWrapper | AnyColumn,
): SQL<unknown> => {
  return sql`LOWER(TRIM(COALESCE(
    CASE
      WHEN COALESCE(json_array_length(${answerArrayColumn}), 0) > 0 THEN ${getJoinedJsonArrayText(answerArrayColumn)}
      ELSE ${answerColumn}
    END,
    ''
  )))`
}

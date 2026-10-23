import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'

export const articlesRoutesGetSearch = async ({query}: {query: {q: string}}) => {
  const {q} = query

  if (!q || q.trim() === '') {
    return {data: []}
  }

  const searchTerm = q.trim()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(searchTerm)

  const searchResults = await getAppDatabaseService().queryJson<{
    id: string
    createdAt: unknown
    articleId: string | null
    articleTitle: string
    articleAuthors: unknown
  }>(`
        SELECT
          id,
          created_at AS createdAt,
          article_id AS articleId,
          article_title AS articleTitle,
          TO_JSON(article_authors) AS articleAuthors
        FROM app.article
        WHERE ${isUuid ? `id = '${escapeSqlString(searchTerm)}' OR` : ''}
          article_id = '${escapeSqlString(searchTerm)}'
          OR LOWER(COALESCE(article_title, '')) LIKE LOWER('%${escapeSqlString(searchTerm)}%')
        ORDER BY
          CASE
            WHEN ${isUuid ? `id = '${escapeSqlString(searchTerm)}'` : 'FALSE'} THEN 0
            WHEN article_id = '${escapeSqlString(searchTerm)}' THEN 1
            ELSE 2
          END,
          article_title ASC
        LIMIT 50
      `)

  const data = searchResults.map((row) => {
    const articleAuthors = getJsonValue(row.articleAuthors)
    return {
      id: row.id,
      createdAt: getDateValue(row.createdAt),
      articleId: row.articleId,
      articleTitle: row.articleTitle,
      articleAuthors: Array.isArray(articleAuthors)
        ? articleAuthors.filter((value): value is string => {
            return typeof value === 'string'
          })
        : null,
    }
  })

  return {data}
}

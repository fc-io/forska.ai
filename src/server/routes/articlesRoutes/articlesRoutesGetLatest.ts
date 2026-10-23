import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'

export const articlesRoutesGetLatest = async () => {
  const rows = await getAppDatabaseService().queryJson<{
    id: string
    articleId: string | null
    articleTitle: string
    articleAuthors: unknown
    articleCreatedAt: unknown
    arxivId: string | null
    biorxivId: string | null
    doi: string | null
    medrxivId: string | null
    pubmedId: string | null
    sourceMetadata: unknown
    url: string | null
  }>(`
      SELECT
        id,
        article_id AS articleId,
        article_title AS articleTitle,
        TO_JSON(article_authors) AS articleAuthors,
        article_created_at AS articleCreatedAt,
        arxiv_id AS arxivId,
        biorxiv_id AS biorxivId,
        doi,
        medrxiv_id AS medrxivId,
        pubmed_id AS pubmedId,
        TO_JSON(source_metadata) AS sourceMetadata,
        url
      FROM app.article
      ORDER BY COALESCE(article_created_at, created_at) DESC, created_at DESC, id DESC
      LIMIT 200
    `)

  const data = rows.map((row) => {
    const articleAuthors = getJsonValue(row.articleAuthors)
    return {
      id: row.id,
      articleId: row.articleId,
      articleTitle: row.articleTitle,
      articleAuthors: Array.isArray(articleAuthors)
        ? articleAuthors.filter((value): value is string => {
            return typeof value === 'string'
          })
        : null,
      articleCreatedAt: getDateValue(row.articleCreatedAt),
      arxivId: row.arxivId,
      biorxivId: row.biorxivId,
      doi: row.doi,
      medrxivId: row.medrxivId,
      pubmedId: row.pubmedId,
      sourceMetadata: getJsonValue(row.sourceMetadata),
      url: row.url,
    }
  })

  return {data}
}

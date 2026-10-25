import {getSqlLiteral} from './appQueryHelpers.ts'

export type ComparisonProjectCovidenceExportArticleRow = {
  articleAuthors: unknown
  articleId: string
  articleSummary: string | null
  articleTitle: string | null
  covidence: unknown
  doi: string | null
  pubmedId: string | null
  sourceMetadata: unknown
}

export type ComparisonProjectCovidenceExportArticleScope = {
  importRouteIds: readonly string[]
  sourceProjectIds: readonly string[]
  useImportRoutesForScope: boolean
}

type ComparisonProjectCovidenceExportArticleDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

const getSqlLiteralList = (values: readonly string[]) => {
  return values.map(getSqlLiteral).join(', ')
}

const getCovidenceImportRouteScopeSql = (scope: ComparisonProjectCovidenceExportArticleScope) => {
  const scopeParts = [
    scope.sourceProjectIds.length > 0
      ? `air.import_route_id IN (
          SELECT pir.import_route_id
          FROM app.project_import_route pir
          WHERE pir.project_id IN (${getSqlLiteralList(scope.sourceProjectIds)})
        )`
      : null,
    scope.useImportRoutesForScope && scope.importRouteIds.length > 0
      ? `air.import_route_id IN (${getSqlLiteralList(scope.importRouteIds)})`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })

  return scopeParts.length > 0 ? `(${scopeParts.join(' OR ')})` : 'FALSE'
}

const getComparisonProjectCovidenceExportArticlesSql = (
  articleIds: readonly string[],
  scope: ComparisonProjectCovidenceExportArticleScope,
) => {
  const articleRows = articleIds
    .map((articleId) => {
      return `(${getSqlLiteral(articleId)})`
    })
    .join(', ')

  return `
    WITH
      export_article(article_id) AS (VALUES ${articleRows}),
      covidence_source AS (
        SELECT
          air.article_id,
          json_extract(air.raw_payload, '$.covidence') AS covidence,
          ROW_NUMBER() OVER (
            PARTITION BY air.article_id
            ORDER BY air.updated_at DESC, air.id ASC
          ) AS covidence_rank
        FROM app.article_import_route air
        INNER JOIN export_article ON export_article.article_id = air.article_id
        WHERE ${getCovidenceImportRouteScopeSql(scope)}
          AND json_extract(air.raw_payload, '$.covidence.citation') IS NOT NULL
      )
    SELECT
      article.id AS articleId,
      article.article_title AS articleTitle,
      article.article_summary AS articleSummary,
      TO_JSON(article.article_authors) AS articleAuthors,
      article.doi AS doi,
      article.pubmed_id AS pubmedId,
      article.source_metadata AS sourceMetadata,
      covidence_source.covidence AS covidence
    FROM export_article
    INNER JOIN app.article article ON article.id = export_article.article_id
    LEFT JOIN covidence_source
      ON covidence_source.article_id = article.id
     AND covidence_source.covidence_rank = 1
  `
}

export const readComparisonProjectCovidenceExportArticles = async (input: {
  articleIds: readonly string[]
  database: ComparisonProjectCovidenceExportArticleDatabase
  scope: ComparisonProjectCovidenceExportArticleScope
}) => {
  return input.articleIds.length === 0
    ? []
    : input.database.queryJson<ComparisonProjectCovidenceExportArticleRow>(
        getComparisonProjectCovidenceExportArticlesSql(input.articleIds, input.scope),
      )
}

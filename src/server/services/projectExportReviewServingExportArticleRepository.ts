import {getSqlLiteral} from './appQueryHelpers.ts'

export type ReviewServingExportArticleRow = {
  arxivId: string | null
  articleAuthors: unknown
  articleCreatedAt: unknown
  articleExternalId: string | null
  articleId: string
  articleOriginalData: unknown
  articleSourceMetadata: unknown
  articleSummary: string | null
  articleTitle: string | null
  articleUpdatedAt: unknown
  articleUrl: string | null
  biorxivId: string | null
  doi: string | null
  medrxivId: string | null
  pubmedId: string | null
}

export type ReviewServingExportSnapshotScope = {projectId: string; reviewConfigHash: string | null; snapshotId: string}

export type ReviewServingExportArticleRepositoryDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

export const readReviewServingExportArticles = async (input: {
  articleIds: string[]
  database: ReviewServingExportArticleRepositoryDatabase
  snapshotScopes: ReviewServingExportSnapshotScope[]
}) => {
  const scopeRows = input.snapshotScopes
    .map((scope, index) => {
      return `(${getSqlLiteral(scope.projectId)}, ${getSqlLiteral(scope.reviewConfigHash)}, ${getSqlLiteral(scope.snapshotId)}, ${index})`
    })
    .join(', ')
  const articleRows = input.articleIds
    .map((articleId) => {
      return `(${getSqlLiteral(articleId)})`
    })
    .join(', ')
  const rows = await input.database.queryJson<ReviewServingExportArticleRow & {sourceProjectOrder: number}>(`
    WITH
      export_scope(project_id, review_config_hash, snapshot_id, source_project_order) AS (VALUES ${scopeRows}),
      export_article(article_id) AS (VALUES ${articleRows}),
      ranked_export_article AS (
        SELECT
          s.article_id AS articleId,
          COALESCE(selected_hot.external_id, article.article_id) AS articleExternalId,
          article.arxiv_id AS arxivId,
          article.biorxiv_id AS biorxivId,
          article.doi AS doi,
          article.medrxiv_id AS medrxivId,
          article.pubmed_id AS pubmedId,
          COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS articleUrl,
          COALESCE(selected_hot.article_title, article.article_title) AS articleTitle,
          LEFT(article.article_summary, 2000) AS articleSummary,
          TO_JSON(article.article_authors) AS articleAuthors,
          s.article_created_at AS articleCreatedAt,
          article.article_updated_at AS articleUpdatedAt,
          selected_source.raw_payload AS articleOriginalData,
          CASE
            WHEN article.source_metadata IS NULL AND selected_source.import_metadata IS NULL THEN NULL
            ELSE json_merge_patch(
              COALESCE(article.source_metadata, CAST('{}' AS JSON)),
              COALESCE(selected_source.import_metadata, CAST('{}' AS JSON))
            )
          END AS articleSourceMetadata,
          export_scope.source_project_order AS sourceProjectOrder,
          ROW_NUMBER() OVER (
            PARTITION BY s.article_id
            ORDER BY export_scope.source_project_order ASC, s.list_mode_key ASC
          ) AS exportArticleRank
        FROM export_scope
        INNER JOIN mart.review_article_serving_v4 s
          ON s.project_id = export_scope.project_id
         AND s.review_config_hash IS NOT DISTINCT FROM export_scope.review_config_hash
         AND s.snapshot_id = export_scope.snapshot_id
        INNER JOIN export_article
          ON export_article.article_id = s.article_id
        LEFT JOIN app.article article
          ON article.id = s.article_id
        LEFT JOIN app.review_serving_snapshot_manifest manifest
          ON manifest.project_id = s.project_id
         AND manifest.review_config_hash IS NOT DISTINCT FROM s.review_config_hash
         AND manifest.snapshot_id = s.snapshot_id
        LEFT JOIN app.review_selected_article_import_v4 selected_base
          ON selected_base.project_id = s.project_id
         AND selected_base.project_scope_identity = json_extract_string(manifest.composed_identity_json, '$.projectScope.projectionIdentity')
         AND selected_base.selected_import_snapshot_id = manifest.selected_import_snapshot_id
         AND selected_base.article_id = s.article_id
         AND NOT selected_base.tombstone
        LEFT JOIN app.review_import_article_hot_field selected_hot
          ON selected_hot.import_route_id = selected_base.import_route_id
         AND selected_hot.article_id = s.article_id
         AND selected_hot.source_record_key = selected_base.source_record_key
         AND NOT selected_hot.tombstone
        LEFT JOIN app.article_import_route_source_record selected_source
          ON selected_source.import_route_id = selected_base.import_route_id
         AND selected_source.article_id = s.article_id
         AND selected_source.source_record_key = selected_base.source_record_key
         AND selected_source.quarantined_at IS NULL
      )
    SELECT * EXCLUDE (exportArticleRank)
    FROM ranked_export_article
    WHERE exportArticleRank = 1
    ORDER BY articleId ASC, sourceProjectOrder ASC
    LIMIT ${getSqlLiteral(input.articleIds.length * Math.max(input.snapshotScopes.length, 1))}
  `)

  return rows.reduce<ReviewServingExportArticleRow[]>((articles, row) => {
    return articles.some((article) => {
      return article.articleId === row.articleId
    })
      ? articles
      : [...articles, row]
  }, [])
}

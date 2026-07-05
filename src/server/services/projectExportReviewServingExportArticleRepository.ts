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
          s.article_external_id AS articleExternalId,
          s.arxiv_id AS arxivId,
          s.biorxiv_id AS biorxivId,
          s.doi AS doi,
          s.medrxiv_id AS medrxivId,
          s.pmid AS pubmedId,
          s.url AS articleUrl,
          s.article_title AS articleTitle,
          payload.abstract_text AS articleSummary,
          TO_JSON(article.article_authors) AS articleAuthors,
          s.article_created_at AS articleCreatedAt,
          s.article_updated_at AS articleUpdatedAt,
          selected_source.raw_payload AS articleOriginalData,
          payload.source_metadata AS articleSourceMetadata,
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
         AND selected_base.project_scope_identity = s.project_scope_identity
         AND selected_base.selected_import_snapshot_id = manifest.selected_import_snapshot_id
         AND selected_base.article_id = s.article_id
        LEFT JOIN app.article_import_route_source_record selected_source
          ON selected_source.import_route_id = CASE
            WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
            ELSE selected_base.import_route_id
          END
         AND selected_source.article_id = s.article_id
         AND selected_source.source_record_key = CASE
           WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL
           ELSE selected_base.source_record_key
         END
         AND selected_source.quarantined_at IS NULL
        LEFT JOIN mart.review_article_serving_payload_v4 payload
          ON payload.project_id = s.project_id
         AND payload.display_identity = s.display_identity
         AND payload.payload_identity = s.payload_identity
         AND payload.snapshot_id = s.snapshot_id
         AND payload.article_id = s.article_id
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

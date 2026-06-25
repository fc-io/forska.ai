ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS source_record_key VARCHAR;
ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS article_title VARCHAR;
ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS journal_title VARCHAR;
ALTER TABLE mart.review_selected_import_patch_v4 ADD COLUMN IF NOT EXISTS external_id VARCHAR;

WITH legacy_patch AS (
  SELECT
    patch.project_id,
    patch.project_scope_identity,
    patch.selected_import_snapshot_id,
    patch.patch_watermark,
    patch.article_id
  FROM mart.review_selected_import_patch_v4 patch
  WHERE NOT patch.tombstone
    AND patch.source_record_key IS NULL
    AND patch.article_title IS NULL
    AND patch.journal_title IS NULL
    AND patch.external_id IS NULL
),
selected_import_candidates AS (
  SELECT
    legacy.project_id,
    legacy.project_scope_identity,
    legacy.selected_import_snapshot_id,
    legacy.patch_watermark,
    legacy.article_id,
    hot.import_route_id,
    hot.source_record_key,
    hot.selected_rank_key,
    hot.selected_rank_numeric,
    hot.publication_year,
    hot.article_title,
    hot.journal_title,
    hot.external_id,
    hot.duplicate_flag,
    hot.conflict_flag,
    CASE WHEN hot.selected_rank_numeric IS NULL THEN 1e308 ELSE hot.selected_rank_numeric END AS rank_numeric_sort,
    CASE
      WHEN hot.selected_rank_key IS NULL THEN '~'
      WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)
      ELSE concat('1:', hot.selected_rank_key)
    END AS rank_key_sort
  FROM legacy_patch legacy
  LEFT JOIN mart.project_scope_article scope
    ON scope.project_id = legacy.project_id
    AND scope.article_id = legacy.article_id
  INNER JOIN app.project_import_route project_route
    ON project_route.project_id = legacy.project_id
  INNER JOIN app.review_import_article_hot_field hot
    ON hot.import_route_id = project_route.import_route_id
    AND hot.article_id = legacy.article_id
    AND NOT hot.tombstone
  LEFT JOIN app.article_import_route current_link
    ON current_link.import_route_id = hot.import_route_id
    AND current_link.article_id = hot.article_id
    AND current_link.source_record_key = hot.source_record_key
  WHERE COALESCE(scope.in_curated_scope, FALSE) OR COALESCE(scope.in_route_scope, FALSE)
),
selected_import_winner AS (
  SELECT
    candidate.project_id,
    candidate.project_scope_identity,
    candidate.selected_import_snapshot_id,
    candidate.patch_watermark,
    candidate.article_id,
    candidate.import_route_id,
    candidate.source_record_key,
    candidate.selected_rank_key,
    candidate.selected_rank_numeric,
    candidate.publication_year,
    candidate.article_title,
    candidate.journal_title,
    candidate.external_id,
    candidate.duplicate_flag,
    candidate.conflict_flag
  FROM selected_import_candidates candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM selected_import_candidates better
    WHERE better.project_id = candidate.project_id
      AND better.project_scope_identity = candidate.project_scope_identity
      AND better.selected_import_snapshot_id = candidate.selected_import_snapshot_id
      AND better.patch_watermark = candidate.patch_watermark
      AND better.article_id = candidate.article_id
      AND (
        better.rank_numeric_sort < candidate.rank_numeric_sort
        OR (
          better.rank_numeric_sort = candidate.rank_numeric_sort
          AND better.rank_key_sort < candidate.rank_key_sort
        )
        OR (
          better.rank_numeric_sort = candidate.rank_numeric_sort
          AND better.rank_key_sort = candidate.rank_key_sort
          AND better.import_route_id < candidate.import_route_id
        )
        OR (
          better.rank_numeric_sort = candidate.rank_numeric_sort
          AND better.rank_key_sort = candidate.rank_key_sort
          AND better.import_route_id = candidate.import_route_id
          AND better.source_record_key < candidate.source_record_key
        )
      )
  )
),
selected_import_rebuild AS (
  SELECT
    legacy.project_id,
    legacy.project_scope_identity,
    legacy.selected_import_snapshot_id,
    legacy.patch_watermark,
    legacy.article_id,
    winner.import_route_id,
    winner.source_record_key,
    winner.selected_rank_key,
    winner.selected_rank_numeric,
    winner.publication_year,
    winner.article_title,
    winner.journal_title,
    winner.external_id,
    winner.duplicate_flag,
    winner.conflict_flag,
    winner.article_id IS NULL AS tombstone
  FROM legacy_patch legacy
  LEFT JOIN selected_import_winner winner
    ON winner.project_id = legacy.project_id
    AND winner.project_scope_identity = legacy.project_scope_identity
    AND winner.selected_import_snapshot_id = legacy.selected_import_snapshot_id
    AND winner.patch_watermark = legacy.patch_watermark
    AND winner.article_id = legacy.article_id
)
UPDATE mart.review_selected_import_patch_v4 AS patch
SET
  import_route_id = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.import_route_id END,
  source_record_key = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.source_record_key END,
  selected_rank_key = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.selected_rank_key END,
  selected_rank_numeric = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.selected_rank_numeric END,
  publication_year = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.publication_year END,
  article_title = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.article_title END,
  journal_title = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.journal_title END,
  external_id = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.external_id END,
  duplicate_flag = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.duplicate_flag END,
  conflict_flag = CASE WHEN rebuild.tombstone THEN NULL ELSE rebuild.conflict_flag END,
  tombstone = rebuild.tombstone,
  patch_updated_at = current_timestamp
FROM selected_import_rebuild rebuild
WHERE patch.project_id = rebuild.project_id
  AND patch.project_scope_identity = rebuild.project_scope_identity
  AND patch.selected_import_snapshot_id = rebuild.selected_import_snapshot_id
  AND patch.patch_watermark = rebuild.patch_watermark
  AND patch.article_id = rebuild.article_id;

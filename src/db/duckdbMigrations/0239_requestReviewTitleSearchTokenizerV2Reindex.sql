-- The review title search tokenizer changed to title-token-v2 (Unicode letters
-- and digits, CJK runs indexed as characters plus bigrams). Postings built by
-- the previous ASCII-only tokenizer contain no tokens for non-Latin titles, so
-- every project that already serves a review snapshot gets one project-scoped
-- search delta. The projector worker turns that into a search-only rebuild
-- through the ordinary dirty-work pipeline.

INSERT INTO app.review_delta_reconciliation_cursor (source_partition, source_high_water_mark)
SELECT DISTINCT 'projectReviewConfig:' || snapshot.project_id, 0
FROM app.review_serving_snapshot_manifest snapshot
WHERE snapshot.snapshot_status IN ('active', 'candidate')
  AND NOT EXISTS (
    SELECT 1
    FROM app.review_delta_reconciliation_cursor cursor
    WHERE cursor.source_partition = 'projectReviewConfig:' || snapshot.project_id
  );

UPDATE app.review_delta_reconciliation_cursor
SET
  source_high_water_mark = source_high_water_mark + 1,
  updated_at = current_timestamp
WHERE source_partition IN (
  SELECT DISTINCT 'projectReviewConfig:' || snapshot.project_id
  FROM app.review_serving_snapshot_manifest snapshot
  WHERE snapshot.snapshot_status IN ('active', 'candidate')
)
AND NOT EXISTS (
  SELECT 1
  FROM app.review_change_delta existing
  WHERE existing.idempotency_key =
    'review-serving-delta:title-search-tokenizer-reindex:title-token-v2:' || split_part(source_partition, ':', 2)
);

INSERT INTO app.review_change_delta (
  delta_id,
  change_kind,
  source_table,
  source_row_id,
  source_operation,
  source_partition,
  source_high_water_mark,
  source_updated_at,
  idempotency_key,
  payload_version,
  project_id,
  tombstone,
  payload_json,
  created_at,
  reconciled_at
)
SELECT
  'delta:' || md5('review-title-search-tokenizer-reindex:title-token-v2:' || project.project_id),
  'project.searchTokenizer.updated',
  'app.project',
  project.project_id,
  'update',
  'projectReviewConfig:' || project.project_id,
  cursor.source_high_water_mark,
  current_timestamp,
  'review-serving-delta:title-search-tokenizer-reindex:title-token-v2:' || project.project_id,
  1,
  project.project_id,
  FALSE,
  json_object('projectId', project.project_id, 'tokenizerVersion', 'title-token-v2'),
  current_timestamp,
  NULL
FROM (
  SELECT DISTINCT snapshot.project_id
  FROM app.review_serving_snapshot_manifest snapshot
  WHERE snapshot.snapshot_status IN ('active', 'candidate')
) project
INNER JOIN app.review_delta_reconciliation_cursor cursor
  ON cursor.source_partition = 'projectReviewConfig:' || project.project_id
WHERE NOT EXISTS (
  SELECT 1
  FROM app.review_change_delta existing
  WHERE existing.idempotency_key =
    'review-serving-delta:title-search-tokenizer-reindex:title-token-v2:' || project.project_id
);

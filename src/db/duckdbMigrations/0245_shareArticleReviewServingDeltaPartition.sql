-- Article review-serving deltas now share the source partition 'article:all' instead of one partition per article
-- (articleReviewServingSourcePartition). Per-article partitions made every dirty-work claim and every delta-intake
-- call handle a single article, so the ~3 creation deltas an import writes per new article drained at a few
-- articles per worker cycle. This moves the existing backlog onto the shared partition:
-- 1. unreconciled per-article deltas are re-appended to 'article:all' in their original order and the originals
--    are marked reconciled, so delta intake turns them into batched dirty work;
-- 2. pending per-article dirty work is re-emitted the same way from its latest delta and closed as 'repartitioned';
-- 3. the 'article:all' counter starts above every per-article counter, so stale aggregate `article` watermarks in
--    manifests and rebuild requests cannot cover the new rows.

CREATE TEMP TABLE shared_article_partition_base AS
SELECT GREATEST(
  COALESCE((
    SELECT MAX(source_high_water_mark)
    FROM app.review_delta_reconciliation_cursor
    WHERE source_partition LIKE 'article:%'
  ), 0),
  COALESCE((
    SELECT MAX(source_high_water_mark)
    FROM app.review_change_delta
    WHERE source_partition LIKE 'article:%'
  ), 0)
) AS base_high_water_mark;

CREATE TEMP TABLE shared_article_partition_source AS
WITH per_article_delta AS (
  SELECT delta_id
  FROM app.review_change_delta
  WHERE reconciled_at IS NULL
    AND source_partition LIKE 'article:%'
    AND source_partition <> 'article:all'
  UNION
  SELECT dirty.latest_delta_id AS delta_id
  FROM app.review_serving_dirty_work dirty
  WHERE dirty.status <> 'completed'
    AND dirty.source_partition LIKE 'article:%'
    AND dirty.source_partition <> 'article:all'
    AND dirty.latest_delta_id IS NOT NULL
)
SELECT
  delta.delta_id,
  delta.reconciled_at IS NULL AS was_unreconciled,
  base.base_high_water_mark + ROW_NUMBER() OVER (
    ORDER BY delta.created_at, delta.source_high_water_mark, delta.delta_id
  ) AS shared_high_water_mark
FROM app.review_change_delta delta
INNER JOIN per_article_delta ON per_article_delta.delta_id = delta.delta_id
CROSS JOIN shared_article_partition_base base
WHERE delta.source_partition LIKE 'article:%'
  AND delta.source_partition <> 'article:all';

INSERT INTO app.review_change_delta BY NAME
SELECT delta.* REPLACE (
  'delta:' || md5('shared-article-partition:' || delta.delta_id) AS delta_id,
  'article:all' AS source_partition,
  source.shared_high_water_mark AS source_high_water_mark,
  'review-serving-delta:shared-article-partition:' || delta.delta_id AS idempotency_key,
  CAST(NULL AS TIMESTAMPTZ) AS reconciled_at
)
FROM app.review_change_delta delta
INNER JOIN shared_article_partition_source source ON source.delta_id = delta.delta_id;

UPDATE app.review_change_delta
SET reconciled_at = current_timestamp
WHERE delta_id IN (
  SELECT delta_id
  FROM shared_article_partition_source
  WHERE was_unreconciled
);

UPDATE app.review_serving_dirty_work
SET
  status = 'completed',
  lifecycle_reason = 'repartitioned',
  updated_at = current_timestamp
WHERE status <> 'completed'
  AND source_partition LIKE 'article:%'
  AND source_partition <> 'article:all'
  AND latest_delta_id IN (SELECT delta_id FROM shared_article_partition_source);

UPDATE app.review_serving_dirty_work_claim_state
SET
  status = 'completed',
  lifecycle_reason = 'repartitioned',
  updated_at = current_timestamp
WHERE status <> 'completed'
  AND source_partition LIKE 'article:%'
  AND source_partition <> 'article:all'
  AND dirty_work_id IN (
    SELECT dirty_work_id
    FROM app.review_serving_dirty_work
    WHERE lifecycle_reason = 'repartitioned'
  );

INSERT INTO app.review_delta_reconciliation_cursor (source_partition, source_high_water_mark)
SELECT 'article:all', base.base_high_water_mark
FROM shared_article_partition_base base
WHERE NOT EXISTS (
  SELECT 1
  FROM app.review_delta_reconciliation_cursor cursor
  WHERE cursor.source_partition = 'article:all'
);

UPDATE app.review_delta_reconciliation_cursor
SET
  source_high_water_mark = GREATEST(
    source_high_water_mark,
    (SELECT base_high_water_mark FROM shared_article_partition_base),
    COALESCE((SELECT MAX(shared_high_water_mark) FROM shared_article_partition_source), 0)
  ),
  updated_at = current_timestamp
WHERE source_partition = 'article:all';

DROP TABLE shared_article_partition_source;
DROP TABLE shared_article_partition_base;

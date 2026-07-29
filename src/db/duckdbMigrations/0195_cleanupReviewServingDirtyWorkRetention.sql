UPDATE app.review_serving_project_dirty_source_watermark existing
SET
  source_high_water_mark = GREATEST(existing.source_high_water_mark, completed.source_high_water_mark),
  updated_at = CASE
    WHEN completed.source_high_water_mark > existing.source_high_water_mark
      THEN completed.updated_at
    ELSE existing.updated_at
  END
FROM (
  SELECT
    project_id,
    source_partition,
    MAX(latest_source_high_water_mark) AS source_high_water_mark,
    current_timestamp AS updated_at
  FROM app.review_serving_dirty_work
  WHERE project_id IS NOT NULL
  GROUP BY project_id, source_partition
) AS completed
WHERE existing.project_id = completed.project_id
  AND existing.source_partition = completed.source_partition;

INSERT INTO app.review_serving_project_dirty_source_watermark (
  project_id,
  source_partition,
  source_high_water_mark,
  updated_at
)
SELECT
  completed.project_id,
  completed.source_partition,
  completed.source_high_water_mark,
  completed.updated_at
FROM (
  SELECT
    project_id,
    source_partition,
    MAX(latest_source_high_water_mark) AS source_high_water_mark,
    current_timestamp AS updated_at
  FROM app.review_serving_dirty_work
  WHERE project_id IS NOT NULL
  GROUP BY project_id, source_partition
) AS completed
WHERE NOT EXISTS (
  SELECT 1
  FROM app.review_serving_project_dirty_source_watermark existing
  WHERE existing.project_id = completed.project_id
    AND existing.source_partition = completed.source_partition
);

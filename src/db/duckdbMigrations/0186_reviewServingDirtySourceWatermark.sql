CREATE TABLE IF NOT EXISTS app.review_serving_project_dirty_source_watermark (
  project_id VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  source_high_water_mark BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, source_partition),
  CHECK (length(trim(project_id)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (source_high_water_mark >= 0)
);

INSERT INTO app.review_serving_project_dirty_source_watermark (
  project_id,
  source_partition,
  source_high_water_mark,
  updated_at
)
SELECT
  project_id,
  source_partition,
  MAX(latest_source_high_water_mark) AS source_high_water_mark,
  current_timestamp AS updated_at
FROM app.review_serving_dirty_work
WHERE project_id IS NOT NULL
GROUP BY project_id, source_partition
ON CONFLICT(project_id, source_partition) DO UPDATE SET
  source_high_water_mark = GREATEST(
    app.review_serving_project_dirty_source_watermark.source_high_water_mark,
    excluded.source_high_water_mark
  ),
  updated_at = CASE
    WHEN excluded.source_high_water_mark > app.review_serving_project_dirty_source_watermark.source_high_water_mark
      THEN excluded.updated_at
    ELSE app.review_serving_project_dirty_source_watermark.updated_at
  END;

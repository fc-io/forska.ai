DROP TABLE IF EXISTS mart.review_article_serving_payload_v4_coverage_repair;

CREATE TABLE mart.review_article_serving_payload_v4_coverage_repair (
  project_id VARCHAR NOT NULL,
  display_identity VARCHAR NOT NULL,
  payload_identity VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL
);

INSERT INTO mart.review_article_serving_payload_v4_coverage_repair
WITH existing_payload AS (
  SELECT
    COLUMNS(column_name -> column_name IN (
      'project_id',
      'display_identity',
      'payload_identity',
      'snapshot_id',
      'article_id'
    )),
    0 AS row_precedence
  FROM mart.review_article_serving_payload_v4
),
snapshot_component_state AS (
  SELECT
    manifest.project_id,
    manifest.snapshot_id,
    json_extract_string(component_state.value, '$.component') AS component,
    json_extract_string(component_state.value, '$.projectionIdentity') AS projection_identity
  FROM app.review_serving_snapshot_manifest manifest,
    json_each(json_extract(manifest.component_state_json, '$.required')) AS component_state
  UNION ALL
  SELECT
    manifest.project_id,
    manifest.snapshot_id,
    json_extract_string(component_state.value, '$.component') AS component,
    json_extract_string(component_state.value, '$.projectionIdentity') AS projection_identity
  FROM app.review_serving_snapshot_manifest manifest,
    json_each(json_extract(manifest.component_state_json, '$.optional')) AS component_state
),
snapshot_payload_identity AS (
  SELECT
    project_id,
    snapshot_id,
    max(CASE WHEN component = 'display' THEN projection_identity END) AS display_identity,
    max(CASE WHEN component = 'payload' THEN projection_identity END) AS payload_identity
  FROM snapshot_component_state
  GROUP BY project_id, snapshot_id
),
serving_payload_gaps AS (
  SELECT
    serving.project_id,
    snapshot_payload_identity.display_identity,
    snapshot_payload_identity.payload_identity,
    serving.snapshot_id,
    serving.article_id,
    1 AS row_precedence
  FROM mart.review_article_serving_v4 serving
  INNER JOIN snapshot_payload_identity
    ON snapshot_payload_identity.project_id = serving.project_id
   AND snapshot_payload_identity.snapshot_id = serving.snapshot_id
  WHERE snapshot_payload_identity.display_identity IS NOT NULL
    AND snapshot_payload_identity.payload_identity IS NOT NULL
  GROUP BY
    serving.project_id,
    snapshot_payload_identity.display_identity,
    snapshot_payload_identity.payload_identity,
    serving.snapshot_id,
    serving.article_id
),
payload_union AS (
  SELECT * FROM existing_payload
  UNION ALL BY NAME
  SELECT * FROM serving_payload_gaps
)
SELECT
  project_id,
  display_identity,
  payload_identity,
  snapshot_id,
  article_id
FROM payload_union
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY project_id, display_identity, payload_identity, snapshot_id, article_id
  ORDER BY row_precedence ASC, article_id ASC
) = 1;

DROP TABLE mart.review_article_serving_payload_v4;

ALTER TABLE mart.review_article_serving_payload_v4_coverage_repair RENAME TO review_article_serving_payload_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_repaired_pk
ON mart.review_article_serving_payload_v4(project_id, display_identity, payload_identity, snapshot_id, article_id);

CREATE INDEX IF NOT EXISTS idx_review_article_serving_payload_v4_lookup
ON mart.review_article_serving_payload_v4(project_id, snapshot_id, article_id);

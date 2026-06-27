ALTER TABLE mart.review_article_judgment_detail_serving_v4
ADD COLUMN IF NOT EXISTS payload_kind VARCHAR DEFAULT 'llm';

DROP TABLE IF EXISTS mart.review_article_judgment_detail_serving_v4_payload_kind_next;

CREATE TABLE mart.review_article_judgment_detail_serving_v4_payload_kind_next (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  payload_kind VARCHAR NOT NULL DEFAULT 'llm',
  article_id VARCHAR NOT NULL,
  prompt_id VARCHAR NOT NULL,
  prompt_order INTEGER,
  judgment_id VARCHAR,
  model_id VARCHAR,
  answered_original VARCHAR,
  answered_original_as_array VARCHAR[],
  judgment_payload_json JSON,
  placeholder_kind VARCHAR,
  detail_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id)
);

INSERT INTO mart.review_article_judgment_detail_serving_v4_payload_kind_next (
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  model_id,
  answered_original,
  answered_original_as_array,
  judgment_payload_json,
  placeholder_kind,
  detail_updated_at
)
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  list_mode_key,
  COALESCE(payload_kind, 'llm') AS payload_kind,
  article_id,
  prompt_id,
  prompt_order,
  judgment_id,
  model_id,
  answered_original,
  answered_original_as_array,
  judgment_payload_json,
  placeholder_kind,
  detail_updated_at
FROM mart.review_article_judgment_detail_serving_v4;

DROP TABLE mart.review_article_judgment_detail_serving_v4;

ALTER TABLE mart.review_article_judgment_detail_serving_v4_payload_kind_next
RENAME TO review_article_judgment_detail_serving_v4;

CREATE INDEX IF NOT EXISTS idx_review_article_judgment_detail_serving_v4_article
ON mart.review_article_judgment_detail_serving_v4(project_id, review_config_hash, snapshot_id, article_id, payload_kind, prompt_order);

UPDATE app.review_rebuild_request AS request
SET
  status = 'admitted',
  retry_after = NULL,
  failed_at = NULL,
  last_error = NULL,
  updated_at = current_timestamp
WHERE request.status IN ('failed', 'blocked_over_budget')
  AND NOT EXISTS (
    SELECT 1
    FROM app.review_rebuild_request newer_request
    WHERE newer_request.project_id = request.project_id
      AND newer_request.created_at > request.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM app.review_rebuild_chunk_manifest chunk
    WHERE chunk.request_id = request.request_id
      AND chunk.projection_component = 'judgmentInputContent'
      AND chunk.status IN ('failed', 'blocked_over_budget', 'quarantined')
      AND chunk.last_error ILIKE '%Referenced column "payload_kind" not found%'
  );

UPDATE app.review_rebuild_chunk_manifest AS chunk
SET
  status = 'pending',
  admission_state = 'admitted',
  retry_count = 0,
  retry_after = NULL,
  oom_category = NULL,
  over_budget_reason = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  last_error = NULL,
  updated_at = current_timestamp
WHERE chunk.projection_component = 'judgmentInputContent'
  AND chunk.status IN ('failed', 'blocked_over_budget', 'quarantined')
  AND chunk.last_error ILIKE '%Referenced column "payload_kind" not found%'
  AND EXISTS (
    SELECT 1
    FROM app.review_rebuild_request request
    WHERE request.request_id = chunk.request_id
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_request newer_request
        WHERE newer_request.project_id = request.project_id
          AND newer_request.created_at > request.created_at
      )
  );

-- Completed dirty work was never deleted, so the dirty-work, claim-state and id-reservation tables grew with every
-- change ever projected (18.5M rows each by 2026-09-28, 90% completed) and every claim scanned them. The worker now
-- deletes completed rows an hour after completion, and this migration clears the backlog in one pass. Only open rows
-- are kept, the claim-state and id-reservation tables are rebuilt from them, and the acknowledgement tables, which
-- nothing read except the old retention check, are dropped. Claim-state storage row ids are cleared: a checkpoint
-- renumbers rows once deleted ones are vacuumed, so rows are only addressed by id. Keep semicolons out of these
-- comments: the DuckDB service splits statements on them.

CREATE TEMP TABLE retained_review_serving_dirty_work AS
SELECT *
FROM app.review_serving_dirty_work
WHERE status <> 'completed';

DELETE FROM app.review_serving_dirty_work;

INSERT INTO app.review_serving_dirty_work BY NAME
SELECT *
FROM retained_review_serving_dirty_work;

DROP TABLE retained_review_serving_dirty_work;

DROP TABLE IF EXISTS app.review_serving_dirty_work_claim_state_retained_0248;

CREATE TABLE app.review_serving_dirty_work_claim_state_retained_0248 (
  dirty_work_id VARCHAR PRIMARY KEY,
  storage_row_id BIGINT,
  project_id VARCHAR NOT NULL,
  projection_component VARCHAR NOT NULL,
  projection_identity VARCHAR NOT NULL,
  source_partition VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  latest_source_high_water_mark BIGINT NOT NULL,
  dirty_range_start VARCHAR,
  dirty_range_end VARCHAR,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  lifecycle_reason VARCHAR,
  CHECK (length(trim(dirty_work_id)) > 0),
  CHECK (project_id = '' OR length(trim(project_id)) > 0),
  CHECK (length(trim(projection_component)) > 0),
  CHECK (length(trim(projection_identity)) > 0),
  CHECK (length(trim(source_partition)) > 0),
  CHECK (length(trim(status)) > 0),
  CHECK (latest_source_high_water_mark >= 0)
);

INSERT INTO app.review_serving_dirty_work_claim_state_retained_0248 (
  dirty_work_id,
  storage_row_id,
  project_id,
  projection_component,
  projection_identity,
  source_partition,
  status,
  latest_source_high_water_mark,
  dirty_range_start,
  dirty_range_end,
  updated_at,
  created_at,
  lifecycle_reason
)
SELECT
  claim_state.dirty_work_id,
  NULL,
  claim_state.project_id,
  claim_state.projection_component,
  claim_state.projection_identity,
  claim_state.source_partition,
  claim_state.status,
  claim_state.latest_source_high_water_mark,
  claim_state.dirty_range_start,
  claim_state.dirty_range_end,
  claim_state.updated_at,
  claim_state.created_at,
  claim_state.lifecycle_reason
FROM app.review_serving_dirty_work_claim_state claim_state
WHERE claim_state.dirty_work_id IN (
  SELECT dirty_work_id
  FROM app.review_serving_dirty_work
);

DROP TABLE app.review_serving_dirty_work_claim_state;

ALTER TABLE app.review_serving_dirty_work_claim_state_retained_0248
RENAME TO review_serving_dirty_work_claim_state;

DROP TABLE IF EXISTS app.review_serving_dirty_work_id_lookup_retained_0248;

CREATE TABLE app.review_serving_dirty_work_id_lookup_retained_0248 (
  dirty_work_id VARCHAR PRIMARY KEY,
  CHECK (length(trim(dirty_work_id)) > 0)
);

INSERT INTO app.review_serving_dirty_work_id_lookup_retained_0248 (dirty_work_id)
SELECT dirty_work_id
FROM app.review_serving_dirty_work
GROUP BY dirty_work_id;

DROP TABLE app.review_serving_dirty_work_id_lookup;

ALTER TABLE app.review_serving_dirty_work_id_lookup_retained_0248
RENAME TO review_serving_dirty_work_id_lookup;

DROP TABLE IF EXISTS app.review_serving_dirty_work_ack;

DROP TABLE IF EXISTS app.review_serving_dirty_work_ack_id_lookup;

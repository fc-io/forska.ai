DROP VIEW IF EXISTS mart.review_article_serving_v4;
DROP INDEX IF EXISTS mart.idx_review_article_serving_list_mode_state_v4_lookup;
DROP INDEX IF EXISTS idx_review_article_serving_list_mode_state_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_article_serving_list_mode_state_v4_pk;
DROP INDEX IF EXISTS idx_review_article_serving_list_mode_state_v4_pk;

ALTER TABLE mart.review_article_serving_list_mode_state_v4
ADD COLUMN IF NOT EXISTS duplicate_flag BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.review_article_serving_list_mode_state_v4
ADD COLUMN IF NOT EXISTS conflict_flag BOOLEAN DEFAULT FALSE;

ALTER TABLE mart.review_article_serving_list_mode_state_v4
ADD COLUMN IF NOT EXISTS llm_status VARCHAR;

ALTER TABLE mart.review_article_serving_list_mode_state_v4
ADD COLUMN IF NOT EXISTS human_status VARCHAR;

ALTER TABLE mart.review_article_serving_list_mode_state_v4
ADD COLUMN IF NOT EXISTS llm_has_judgment BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS mart.review_article_filter_state_serving_v4 (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  list_mode_key VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
  llm_status VARCHAR,
  human_status VARCHAR
);

UPDATE mart.review_article_serving_list_mode_state_v4
SET
  duplicate_flag = COALESCE(duplicate_flag, FALSE),
  conflict_flag = COALESCE(conflict_flag, FALSE),
  llm_has_judgment = COALESCE(llm_has_judgment, FALSE);

UPDATE mart.review_article_serving_list_mode_state_v4 state
SET
  duplicate_flag = COALESCE(source.duplicate_flag, FALSE),
  conflict_flag = COALESCE(source.conflict_flag, FALSE),
  llm_status = source.llm_status,
  human_status = source.human_status
FROM (
  SELECT
    filter_state.project_id,
    filter_state.review_config_hash,
    filter_state.snapshot_id,
    filter_state.article_id,
    COALESCE(BOOL_OR(COALESCE(filter_state.duplicate_flag, FALSE)), FALSE) AS duplicate_flag,
    COALESCE(BOOL_OR(COALESCE(filter_state.conflict_flag, FALSE)), FALSE) AS conflict_flag,
    MAX(filter_state.llm_status) AS llm_status,
    MAX(filter_state.human_status) AS human_status
  FROM mart.review_article_filter_state_serving_v4 filter_state
  GROUP BY
    filter_state.project_id,
    filter_state.review_config_hash,
    filter_state.snapshot_id,
    filter_state.article_id
) source
WHERE state.project_id = source.project_id
  AND state.review_config_hash = source.review_config_hash
  AND state.snapshot_id = source.snapshot_id
  AND state.article_id = source.article_id;

UPDATE mart.review_article_serving_list_mode_state_v4 state
SET
  duplicate_flag = COALESCE(state.duplicate_flag, FALSE) OR COALESCE(source.duplicate_flag, FALSE),
  conflict_flag = COALESCE(state.conflict_flag, FALSE) OR COALESCE(source.conflict_flag, FALSE)
FROM (
  SELECT
    state.project_id,
    state.review_config_hash,
    state.snapshot_id,
    state.article_id,
    COALESCE(BOOL_OR(COALESCE(selected_hot.duplicate_flag, FALSE)), FALSE) AS duplicate_flag,
    COALESCE(BOOL_OR(COALESCE(selected_hot.conflict_flag, FALSE)), FALSE) AS conflict_flag
  FROM mart.review_article_serving_list_mode_state_v4 state
  INNER JOIN app.review_serving_snapshot_manifest snapshot
    ON snapshot.project_id = state.project_id
   AND snapshot.review_config_hash IS NOT DISTINCT FROM state.review_config_hash
   AND snapshot.snapshot_id = state.snapshot_id
  LEFT JOIN app.review_selected_import_snapshot selected_snapshot
    ON selected_snapshot.project_id = snapshot.project_id
   AND selected_snapshot.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
  LEFT JOIN app.review_selected_article_import_v4 selected
    ON selected.project_id = snapshot.project_id
   AND selected.project_scope_identity = selected_snapshot.project_scope_identity
   AND selected.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
   AND selected.article_id = state.article_id
   AND NOT selected.tombstone
  LEFT JOIN app.review_import_article_hot_field selected_hot
    ON selected_hot.import_route_id = selected.import_route_id
   AND selected_hot.article_id = selected.article_id
   AND selected_hot.source_record_key = selected.source_record_key
   AND NOT selected_hot.tombstone
  GROUP BY
    state.project_id,
    state.review_config_hash,
    state.snapshot_id,
    state.article_id
) source
WHERE state.project_id = source.project_id
  AND state.review_config_hash = source.review_config_hash
  AND state.snapshot_id = source.snapshot_id
  AND state.article_id = source.article_id;

UPDATE mart.review_article_serving_list_mode_state_v4 state
SET
  llm_status = source.llm_status,
  human_status = source.human_status,
  llm_has_judgment = COALESCE(source.llm_has_judgment, FALSE)
FROM (
  WITH enabled_prompt_count AS (
    SELECT
      project_prompt.project_id,
      COUNT(*) AS prompt_count
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    GROUP BY project_prompt.project_id
  ),
  article_judgment_status AS (
    SELECT
      state.project_id,
      state.review_config_hash,
      state.snapshot_id,
      state.article_id,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'llm'
      ) AS llm_enabled_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'llm'
          AND detail.is_answered IS TRUE
      ) AS llm_answered_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'llm'
          AND detail.is_answered IS TRUE
          AND detail.placeholder_kind IS NULL
      ) AS llm_answered_non_placeholder_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'human'
          AND detail.prompt_id <> 'summary'
          AND detail.is_answered IS TRUE
      ) AS human_answered_prompt_count,
      COUNT(DISTINCT detail.prompt_id) FILTER (
        WHERE detail.payload_kind = 'human'
          AND detail.prompt_id = 'summary'
          AND detail.is_answered IS TRUE
      ) AS human_answered_summary_count
    FROM mart.review_article_serving_list_mode_state_v4 state
    LEFT JOIN mart.review_article_judgment_detail_serving_v4 detail
      ON detail.project_id = state.project_id
     AND detail.review_config_hash = state.review_config_hash
     AND detail.snapshot_id = state.snapshot_id
     AND detail.article_id = state.article_id
     AND detail.payload_kind IN ('llm', 'human')
    GROUP BY
      state.project_id,
      state.review_config_hash,
      state.snapshot_id,
      state.article_id
  )
  SELECT
    article_status.project_id,
    article_status.review_config_hash,
    article_status.snapshot_id,
    article_status.article_id,
    CASE
      WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
      WHEN enabled_prompt_count.prompt_count = article_status.llm_answered_prompt_count THEN 'answered'
      ELSE 'unanswered'
    END AS llm_status,
    article_status.llm_answered_non_placeholder_prompt_count > 0 AS llm_has_judgment,
    CASE
      WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary'
        AND article_status.human_answered_summary_count > 0 THEN 'answered'
      WHEN COALESCE(project.human_judgment_mode, 'prompt') = 'summary' THEN 'unanswered'
      WHEN COALESCE(enabled_prompt_count.prompt_count, 0) = 0 THEN NULL
      WHEN enabled_prompt_count.prompt_count = article_status.human_answered_prompt_count THEN 'answered'
      ELSE 'unanswered'
    END AS human_status
  FROM article_judgment_status article_status
  LEFT JOIN app.project project
    ON project.id = article_status.project_id
  LEFT JOIN enabled_prompt_count
    ON enabled_prompt_count.project_id = article_status.project_id
) source
WHERE state.project_id = source.project_id
  AND state.review_config_hash = source.review_config_hash
  AND state.snapshot_id = source.snapshot_id
  AND state.article_id = source.article_id;

DROP TABLE IF EXISTS mart.review_article_serving_list_mode_state_v4_repair;

CREATE TABLE mart.review_article_serving_list_mode_state_v4_repair (
  project_id VARCHAR NOT NULL,
  review_config_hash VARCHAR NOT NULL,
  snapshot_id VARCHAR NOT NULL,
  article_id VARCHAR NOT NULL,
  list_mode_keys VARCHAR[] NOT NULL,
  llm_patch_watermark BIGINT,
  human_patch_watermark BIGINT,
  both_patch_watermark BIGINT,
  unassessed_patch_watermark BIGINT,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
  llm_status VARCHAR,
  human_status VARCHAR,
  llm_has_judgment BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (llm_patch_watermark IS NULL OR llm_patch_watermark >= 0),
  CHECK (human_patch_watermark IS NULL OR human_patch_watermark >= 0),
  CHECK (both_patch_watermark IS NULL OR both_patch_watermark >= 0),
  CHECK (unassessed_patch_watermark IS NULL OR unassessed_patch_watermark >= 0)
);

INSERT INTO mart.review_article_serving_list_mode_state_v4_repair
SELECT
  project_id,
  review_config_hash,
  snapshot_id,
  article_id,
  list_mode_keys,
  llm_patch_watermark,
  human_patch_watermark,
  both_patch_watermark,
  unassessed_patch_watermark,
  COALESCE(duplicate_flag, FALSE) AS duplicate_flag,
  COALESCE(conflict_flag, FALSE) AS conflict_flag,
  llm_status,
  human_status,
  COALESCE(llm_has_judgment, FALSE) AS llm_has_judgment
FROM mart.review_article_serving_list_mode_state_v4;

DROP TABLE mart.review_article_serving_list_mode_state_v4;

ALTER TABLE mart.review_article_serving_list_mode_state_v4_repair RENAME TO review_article_serving_list_mode_state_v4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_article_serving_list_mode_state_v4_pk
ON mart.review_article_serving_list_mode_state_v4(project_id, review_config_hash, snapshot_id, article_id);

CREATE OR REPLACE VIEW mart.review_article_serving_v4 AS
SELECT
  base.project_id,
  base.review_config_hash,
  base.snapshot_id,
  base.base_generation,
  CASE list_mode.list_mode_key
    WHEN 'llm' THEN state.llm_patch_watermark
    WHEN 'human' THEN state.human_patch_watermark
    WHEN 'both' THEN state.both_patch_watermark
    WHEN 'unassessed' THEN state.unassessed_patch_watermark
    ELSE NULL
  END AS patch_watermark,
  list_mode.list_mode_key,
  base.article_id,
  base.article_created_at,
  base.sort_key,
  base.activity_sort_at,
  COALESCE(state.duplicate_flag, FALSE) AS duplicate_flag,
  COALESCE(state.conflict_flag, FALSE) AS conflict_flag,
  state.llm_status,
  state.human_status
FROM mart.review_article_serving_base_v4 base
INNER JOIN mart.review_article_serving_list_mode_state_v4 state
  ON state.project_id = base.project_id
 AND state.review_config_hash = base.review_config_hash
 AND state.snapshot_id = base.snapshot_id
 AND state.article_id = base.article_id
CROSS JOIN unnest(state.list_mode_keys) AS list_mode(list_mode_key);

DROP INDEX IF EXISTS mart.idx_review_article_filter_state_serving_v4_lookup;
DROP INDEX IF EXISTS idx_review_article_filter_state_serving_v4_lookup;
DROP INDEX IF EXISTS mart.idx_review_article_filter_state_serving_v4_pk;
DROP INDEX IF EXISTS idx_review_article_filter_state_serving_v4_pk;
DROP TABLE IF EXISTS mart.review_article_filter_state_serving_v4;

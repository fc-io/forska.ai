ALTER TABLE app.project_mart_large_rebuild_state
ADD COLUMN IF NOT EXISTS source_dirty_token BIGINT;

ALTER TABLE app.project_mart_large_rebuild_state
ADD COLUMN IF NOT EXISTS source_high_water_dirty_token BIGINT;

ALTER TABLE app.project_mart_large_rebuild_state
ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_app_project_mart_large_rebuild_state_current
ON app.project_mart_large_rebuild_state(project_id, refresh_token, target_generation, superseded_at);

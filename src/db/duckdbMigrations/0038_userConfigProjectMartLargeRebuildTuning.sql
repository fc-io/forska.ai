ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS background_writer_duckdb_memory_limit VARCHAR;

ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS project_mart_large_rebuild_batch_size INTEGER;

ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS project_mart_large_rebuild_max_cycles_per_wake INTEGER;

ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS project_mart_large_rebuild_poll_interval_ms INTEGER;

ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS project_mart_large_rebuild_tuning_mode VARCHAR;

UPDATE app.user_config
SET project_mart_large_rebuild_tuning_mode = 'automatic'
WHERE project_mart_large_rebuild_tuning_mode IS NULL
   OR project_mart_large_rebuild_tuning_mode NOT IN ('automatic', 'manual');

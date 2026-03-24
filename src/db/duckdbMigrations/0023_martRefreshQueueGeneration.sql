ALTER TABLE app.mart_refresh_queue
ADD COLUMN IF NOT EXISTS refresh_generation BIGINT DEFAULT 0;

UPDATE app.mart_refresh_queue
SET refresh_generation = 0
WHERE refresh_generation IS NULL;

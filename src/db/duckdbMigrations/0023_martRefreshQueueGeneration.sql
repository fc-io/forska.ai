ALTER TABLE app.mart_refresh_queue
ADD COLUMN IF NOT EXISTS refresh_generation BIGINT;

UPDATE app.mart_refresh_queue
SET refresh_generation = 0
WHERE refresh_generation IS NULL;

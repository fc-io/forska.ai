-- Rebuilt dirty-work retirement completes a pending row once a rebuild chunk re-read its article after the row's
-- source change arrived. It compared the chunk start with updated_at, but every claim, release, park and requeue
-- also moves updated_at. While a rebuild runs, the projector claims and releases the rows it is waiting for on every
-- wake, so a row released after its chunk started never looked older than that chunk. On one project 55k
-- judgmentInputContent rows stayed pending after the chunks that re-read them, and once that rebuild finished they
-- would have started another bootstrap rebuild of the project. source_changed_at moves only when a source change
-- is merged into the row.

ALTER TABLE app.review_serving_dirty_work
ADD COLUMN IF NOT EXISTS source_changed_at TIMESTAMPTZ;

-- Open rows written before this column: a row whose first and latest source high-water marks are equal has only
-- ever merged one change, and that change had arrived by the time the row was created. For any other row the last
-- change time is unknown, so updated_at stays its bound.
UPDATE app.review_serving_dirty_work
SET source_changed_at = CASE
  WHEN first_source_high_water_mark = latest_source_high_water_mark THEN created_at
  ELSE updated_at
END
WHERE source_changed_at IS NULL
  AND status <> 'completed';

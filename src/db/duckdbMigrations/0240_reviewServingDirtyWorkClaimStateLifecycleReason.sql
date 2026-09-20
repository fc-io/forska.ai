ALTER TABLE app.review_serving_dirty_work_claim_state
ADD COLUMN IF NOT EXISTS lifecycle_reason VARCHAR;

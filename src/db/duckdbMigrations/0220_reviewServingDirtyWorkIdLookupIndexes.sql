CREATE INDEX IF NOT EXISTS idx_review_serving_dirty_work_id_lookup
ON app.review_serving_dirty_work(dirty_work_id);

CREATE INDEX IF NOT EXISTS idx_review_serving_dirty_work_ack_id_lookup
ON app.review_serving_dirty_work_ack(dirty_ack_id);

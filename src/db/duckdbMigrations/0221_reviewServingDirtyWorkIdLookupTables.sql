CREATE TABLE IF NOT EXISTS app.review_serving_dirty_work_id_lookup (
  dirty_work_id VARCHAR PRIMARY KEY,
  CHECK (length(trim(dirty_work_id)) > 0)
);

INSERT INTO app.review_serving_dirty_work_id_lookup (dirty_work_id)
SELECT dirty_work_id
FROM app.review_serving_dirty_work
GROUP BY dirty_work_id;

CREATE TABLE IF NOT EXISTS app.review_serving_dirty_work_ack_id_lookup (
  dirty_ack_id VARCHAR PRIMARY KEY,
  CHECK (length(trim(dirty_ack_id)) > 0)
);

INSERT INTO app.review_serving_dirty_work_ack_id_lookup (dirty_ack_id)
SELECT dirty_ack_id
FROM app.review_serving_dirty_work_ack
GROUP BY dirty_ack_id;

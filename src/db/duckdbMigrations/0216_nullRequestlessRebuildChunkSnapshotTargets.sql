UPDATE app.review_rebuild_chunk_manifest
SET
  snapshot_id = NULL,
  updated_at = current_timestamp
WHERE request_id IS NULL
  AND snapshot_id IS NOT NULL;

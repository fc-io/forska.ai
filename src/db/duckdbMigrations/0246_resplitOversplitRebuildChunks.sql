-- Before 0246 an oversized rebuild chunk was split from its request's row estimate, which every parent chunk of a
-- request carries, so a status parent covering ~15k articles was cut into ~420 children of ~36 articles and each
-- child paid the full per-chunk cost. The worker now splits from the chunk's real scope count. A parent whose
-- children are all still untouched goes back to pending and its children are dropped, so the worker re-splits it
-- into children of the component's row limit when it next claims it. Parents split after an out-of-memory failure
-- keep their children.

CREATE TEMP TABLE resplit_rebuild_chunk_parent AS
SELECT child.parent_chunk_id AS chunk_id
FROM app.review_rebuild_chunk_manifest child
INNER JOIN app.review_rebuild_chunk_manifest parent
  ON parent.chunk_id = child.parent_chunk_id
WHERE child.parent_chunk_id IS NOT NULL
  AND parent.status = 'completed'
  AND parent.checksum = 'split:' || parent.chunk_id
  AND parent.oom_category IS NULL
GROUP BY child.parent_chunk_id
HAVING bool_and(
    child.status = 'pending'
    AND child.lease_owner IS NULL
    AND child.started_at IS NULL
    AND COALESCE(child.retry_count, 0) = 0
  )
  AND COUNT(*) > 1;

DELETE FROM app.review_rebuild_chunk_manifest
WHERE parent_chunk_id IN (SELECT chunk_id FROM resplit_rebuild_chunk_parent);

UPDATE app.review_rebuild_chunk_manifest
SET
  status = 'pending',
  checksum = NULL,
  started_at = NULL,
  completed_at = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = current_timestamp
WHERE chunk_id IN (SELECT chunk_id FROM resplit_rebuild_chunk_parent);

DROP TABLE resplit_rebuild_chunk_parent;

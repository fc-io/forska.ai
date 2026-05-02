UPDATE app.project_mart_large_rebuild_state
SET
  rebuild_phase = 'project_scope_article',
  updated_at = current_timestamp
WHERE refresh_token > 0
  AND rebuild_phase = 'judgment_fact';

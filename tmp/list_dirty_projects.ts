import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'

const rows = await getAppDatabaseService().queryJson(`
  SELECT
    project_id AS projectId,
    CAST(dirty_token AS INTEGER) AS dirtyToken,
    CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
    refresh_status AS refreshStatus,
    last_failed_at AS lastFailedAt,
    last_error AS lastError,
    last_requested_at AS lastRequestedAt
  FROM app.project_mart_refresh_state
  WHERE dirty_token > last_completed_dirty_token
  ORDER BY last_requested_at ASC
  LIMIT 20
`)

console.log(JSON.stringify(rows, null, 2))

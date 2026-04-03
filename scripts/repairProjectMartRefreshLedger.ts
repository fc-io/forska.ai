import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const projectMartRefreshStateCreateSql = `
  CREATE TABLE app.project_mart_refresh_state (
    project_id VARCHAR PRIMARY KEY REFERENCES app.project(id),
    dirty_token BIGINT NOT NULL DEFAULT 0,
    active_refresh_token BIGINT NOT NULL DEFAULT 0,
    last_completed_refresh_token BIGINT NOT NULL DEFAULT 0,
    last_requested_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    last_request_reason VARCHAR,
    requested_by VARCHAR,
    refresh_status VARCHAR NOT NULL DEFAULT 'idle',
    last_started_at TIMESTAMPTZ,
    last_completed_at TIMESTAMPTZ,
    last_failed_at TIMESTAMPTZ,
    last_error VARCHAR,
    worker_id VARCHAR,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
  )
`

const projectMartRefreshStateIndexSql = `
  CREATE INDEX idx_app_project_mart_refresh_state_claim
  ON app.project_mart_refresh_state(refresh_status, dirty_token, last_completed_refresh_token);

  CREATE INDEX idx_app_project_mart_refresh_state_stale_work
  ON app.project_mart_refresh_state(refresh_status, lease_expires_at);
`

const getCount = async (tableName: string) => {
  const [row] = await getAppDatabaseService().queryJson<{count: number | string}>(`SELECT COUNT(*) AS count FROM ${tableName}`)
  return Number(row?.count ?? 0)
}

const getDuplicateProjectIds = async () => {
  return getAppDatabaseService().queryJson<{projectId: string; rowCount: number | string}>(`
    SELECT project_id AS projectId, COUNT(*) AS rowCount
    FROM app.project_mart_refresh_state
    GROUP BY project_id
    HAVING COUNT(*) > 1
    ORDER BY rowCount DESC, projectId ASC
  `)
}

const rebuildProjectMartRefreshState = async () => {
  const tempTableName = `temp_project_mart_refresh_state_repair_${Date.now()}`

  await getAppDatabaseService().run(`
    CREATE TEMP TABLE ${tempTableName} AS
    SELECT *
    FROM app.project_mart_refresh_state
  `)
  await getAppDatabaseService().run(`DROP TABLE app.project_mart_refresh_state`)
  await getAppDatabaseService().run(projectMartRefreshStateCreateSql)
  await getAppDatabaseService().run(`
    INSERT INTO app.project_mart_refresh_state (
      project_id,
      dirty_token,
      active_refresh_token,
      last_completed_refresh_token,
      last_requested_at,
      last_request_reason,
      requested_by,
      refresh_status,
      last_started_at,
      last_completed_at,
      last_failed_at,
      last_error,
      worker_id,
      lease_expires_at,
      created_at,
      updated_at
    )
    SELECT
      project_id,
      dirty_token,
      active_refresh_token,
      last_completed_refresh_token,
      last_requested_at,
      last_request_reason,
      requested_by,
      refresh_status,
      last_started_at,
      last_completed_at,
      last_failed_at,
      last_error,
      worker_id,
      lease_expires_at,
      created_at,
      updated_at
    FROM ${tempTableName}
  `)
  await getAppDatabaseService().run(projectMartRefreshStateIndexSql)
  await getAppDatabaseService().run(`DROP TABLE ${tempTableName}`)
}

export const repairProjectMartRefreshLedger = async () => {
  return withDuckdbMaintenanceAccess('repair project mart refresh ledger', async () => {
    const beforeCount = await getCount('app.project_mart_refresh_state')
    const duplicateProjectIds = await getDuplicateProjectIds()

    await rebuildProjectMartRefreshState()

    const afterCount = await getCount('app.project_mart_refresh_state')
    const duplicatesAfter = await getDuplicateProjectIds()

    console.log(
      JSON.stringify({
        afterCount,
        beforeCount,
        duplicateProjectIds,
        duplicatesAfter,
        status: 'ok',
      }),
    )
  })
}

if (import.meta.main) {
  await repairProjectMartRefreshLedger()
}

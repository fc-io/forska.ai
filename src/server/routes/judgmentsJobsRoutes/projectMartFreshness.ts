import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../services/judgmentJobSqliteHealthProjectionService.ts'

type ProjectMartFreshnessState = {
  dirtyToken: number | null
  failedMaterializationCount: number
  hasIncompleteDirtyMaterialization: boolean
  hasUnresolvedQuarantineBarrier: boolean
  isFresh: boolean
  lastCompletedDirtyToken: number | null
  pendingMaterializationCount: number
  refreshStatus: string | null
  runningMaterializationCount: number
  status: ProjectMartFreshnessStatus
  unresolvedQuarantineBarrierCount: number
  unreconciledMaterializationCount: number
}
type ProjectMartFreshnessStatus = 'fresh' | 'pending' | 'stale'

const getProjectMartFreshnessStatus = (params: {
  failedMaterializationCount: number
  hasUnresolvedQuarantineBarrier: boolean
  isFresh: boolean
  refreshStatus: string | null
  unreconciledMaterializationCount: number
}): ProjectMartFreshnessStatus => {
  return params.isFresh
    ? 'fresh'
    : params.hasUnresolvedQuarantineBarrier
        || params.failedMaterializationCount > 0
        || params.unreconciledMaterializationCount > 0
        || params.refreshStatus === 'failed'
      ? 'stale'
      : 'pending'
}

export const getProjectMartFreshnessPayload = (freshness: ProjectMartFreshnessState) => {
  return {
    dirtyToken: freshness.dirtyToken,
    failedMaterializationCount: freshness.failedMaterializationCount,
    hasIncompleteDirtyMaterialization: freshness.hasIncompleteDirtyMaterialization,
    hasUnresolvedQuarantineBarrier: freshness.hasUnresolvedQuarantineBarrier,
    isFresh: freshness.isFresh,
    lastCompletedDirtyToken: freshness.lastCompletedDirtyToken,
    pendingMaterializationCount: freshness.pendingMaterializationCount,
    refreshStatus: freshness.refreshStatus,
    runningMaterializationCount: freshness.runningMaterializationCount,
    status: freshness.status,
    unresolvedQuarantineBarrierCount: freshness.unresolvedQuarantineBarrierCount,
    unreconciledMaterializationCount: freshness.unreconciledMaterializationCount,
  }
}

export const getProjectMartFreshnessState = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<ProjectMartFreshnessState> => {
  const [row] = await db.queryJson<{
    dirtyToken: number | null
    failedMaterializationCount: number | null
    incompleteMaterializationCount: number | null
    lastCompletedDirtyToken: number | null
    pendingMaterializationCount: number | null
    refreshStatus: string | null
    runningMaterializationCount: number | null
    unresolvedQuarantineBarrierCount: number | null
    unreconciledMaterializationCount: number | null
  }>(`
    WITH refresh_state AS (
      SELECT
        project_id,
        dirty_token,
        last_completed_dirty_token,
        refresh_status
      FROM app.project_mart_refresh_state
      WHERE project_id = ${getSqlLiteral(projectId)}
      LIMIT 1
    ),
    materialization_summary AS (
      SELECT
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status <> 'completed') AS INTEGER) AS incompleteMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'pending') AS INTEGER) AS pendingMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'running') AS INTEGER) AS runningMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'failed') AS INTEGER) AS failedMaterializationCount,
        CAST(COUNT(*) FILTER (WHERE materialization.materialization_status = 'unreconciled') AS INTEGER) AS unreconciledMaterializationCount
        FROM app.project_mart_dirty_materialization_state materialization
        INNER JOIN refresh_state state ON state.project_id = materialization.project_id
        WHERE state.dirty_token IS NOT NULL
          AND materialization.target_dirty_token <= state.dirty_token
    ),
    quarantine_summary AS (
      SELECT CAST(COUNT(*) AS INTEGER) AS unresolvedQuarantineBarrierCount
      FROM app.project_mart_dirty_refresh_article_quarantine quarantine
      INNER JOIN refresh_state state ON state.project_id = quarantine.project_id
      WHERE state.dirty_token IS NOT NULL
        AND quarantine.dirty_token <= state.dirty_token
        AND quarantine.resolved_at IS NULL
    )
    SELECT
      CAST(state.dirty_token AS INTEGER) AS dirtyToken,
      CAST(state.last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
      state.refresh_status AS refreshStatus,
      COALESCE(materialization_summary.incompleteMaterializationCount, 0) AS incompleteMaterializationCount,
      COALESCE(materialization_summary.pendingMaterializationCount, 0) AS pendingMaterializationCount,
      COALESCE(materialization_summary.runningMaterializationCount, 0) AS runningMaterializationCount,
      COALESCE(materialization_summary.failedMaterializationCount, 0) AS failedMaterializationCount,
      COALESCE(materialization_summary.unreconciledMaterializationCount, 0) AS unreconciledMaterializationCount,
      COALESCE(quarantine_summary.unresolvedQuarantineBarrierCount, 0) AS unresolvedQuarantineBarrierCount
    FROM refresh_state state
    CROSS JOIN materialization_summary
    CROSS JOIN quarantine_summary
  `)
  const dirtyToken = row?.dirtyToken ?? null
  const failedMaterializationCount = Number(row?.failedMaterializationCount ?? 0)
  const incompleteMaterializationCount = Number(row?.incompleteMaterializationCount ?? 0)
  const lastCompletedDirtyToken = row?.lastCompletedDirtyToken ?? null
  const pendingMaterializationCount = Number(row?.pendingMaterializationCount ?? 0)
  const refreshStatus = row?.refreshStatus ?? null
  const runningMaterializationCount = Number(row?.runningMaterializationCount ?? 0)
  const unresolvedQuarantineBarrierCount = Number(row?.unresolvedQuarantineBarrierCount ?? 0)
  const unreconciledMaterializationCount = Number(row?.unreconciledMaterializationCount ?? 0)
  const hasIncompleteDirtyMaterialization = incompleteMaterializationCount > 0
  const hasUnresolvedQuarantineBarrier = unresolvedQuarantineBarrierCount > 0
  const isFresh =
    dirtyToken === null
    || (!hasIncompleteDirtyMaterialization
      && !hasUnresolvedQuarantineBarrier
      && lastCompletedDirtyToken !== null
      && lastCompletedDirtyToken >= dirtyToken)
  const status = getProjectMartFreshnessStatus({
    failedMaterializationCount,
    hasUnresolvedQuarantineBarrier,
    isFresh,
    refreshStatus,
    unreconciledMaterializationCount,
  })

  return {
    dirtyToken,
    failedMaterializationCount,
    hasIncompleteDirtyMaterialization,
    hasUnresolvedQuarantineBarrier,
    isFresh,
    lastCompletedDirtyToken,
    pendingMaterializationCount,
    refreshStatus,
    runningMaterializationCount,
    status,
    unresolvedQuarantineBarrierCount,
    unreconciledMaterializationCount,
  }
}

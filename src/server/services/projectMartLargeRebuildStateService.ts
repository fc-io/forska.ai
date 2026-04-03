import type {ProjectMartLargeRebuildPhase, ProjectMartLargeRebuildStateRecord, ProjectMartRefreshStatus} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

type LargeRebuildStateRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type QueueLargeRebuildParams = {
  cursorArticleCreatedAt?: Date | null
  cursorArticleId?: string | null
  now?: Date
  projectId: string
  rebuildPhase: ProjectMartLargeRebuildPhase
  refreshToken: number
  runner?: LargeRebuildStateRunner
  targetGeneration?: number | null
}

type ClaimLargeRebuildsParams = {leaseMs: number; limit: number; now?: Date; workerId: string}

type LargeRebuildClaim = {
  leaseExpiresAt: Date
  projectId: string
  rebuildPhase: ProjectMartLargeRebuildPhase
  refreshToken: number
  workerId: string
}

type HeartbeatLargeRebuildClaimParams = {leaseMs: number; now?: Date; projectId: string; workerId: string}

type CompleteLargeRebuildParams = {now?: Date; projectId: string; workerId: string}

type FailLargeRebuildParams = {error: string; now?: Date; projectId: string; workerId: string}

type ResetLargeRebuildParams = {
  cursorArticleCreatedAt?: Date | null
  cursorArticleId?: string | null
  now?: Date
  projectId: string
  rebuildPhase?: ProjectMartLargeRebuildPhase
  targetGeneration?: number | null
}

type LargeRebuildStateRow = {
  createdAt: Date
  cursorArticleCreatedAt: Date | null
  cursorArticleId: string | null
  lastCompletedAt: Date | null
  lastError: string | null
  lastFailedAt: Date | null
  lastStartedAt: Date | null
  leaseExpiresAt: Date | null
  projectId: string
  rebuildPhase: ProjectMartLargeRebuildPhase
  refreshStatus: ProjectMartRefreshStatus
  refreshToken: number
  targetGeneration: number | null
  updatedAt: Date
  workerId: string | null
}

const getNow = (value?: Date) => {
  return value ?? new Date()
}

const getLeaseExpiry = (now: Date, leaseMs: number) => {
  return new Date(now.getTime() + leaseMs)
}

const withTransaction = async <T>(runner: LargeRebuildStateRunner | undefined, work: (tx: LargeRebuildStateRunner) => Promise<T>) => {
  return runner ? work(runner) : (getAppDatabaseService().transaction(work) as Promise<T>)
}

const ensureLargeRebuildStateRow = async (runner: LargeRebuildStateRunner, projectId: string) => {
  await runner.run(`
    INSERT INTO app.project_mart_large_rebuild_state (project_id)
    VALUES (${getSqlLiteral(projectId)})
    ON CONFLICT(project_id) DO NOTHING
  `)
}

const getLargeRebuildStateRecord = async (runner: LargeRebuildStateRunner, projectId: string) => {
  const [row] = await runner.queryJson<ProjectMartLargeRebuildStateRecord>(`
    SELECT
      project_id AS projectId,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      rebuild_phase AS rebuildPhase,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return row ?? null
}

const queueLargeRebuild = async ({
  cursorArticleCreatedAt,
  cursorArticleId,
  now,
  projectId,
  rebuildPhase,
  refreshToken,
  runner,
  targetGeneration,
}: QueueLargeRebuildParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)

    await ensureLargeRebuildStateRow(tx, projectId)
    await tx.run(`
      UPDATE app.project_mart_large_rebuild_state
      SET
        refresh_token = GREATEST(refresh_token, ${refreshToken}),
        rebuild_phase = ${getSqlLiteral(rebuildPhase)},
        cursor_article_created_at = ${cursorArticleCreatedAt === undefined || cursorArticleCreatedAt === null ? 'NULL' : getTimestampLiteral(cursorArticleCreatedAt)},
        cursor_article_id = ${getSqlLiteral(cursorArticleId ?? null)},
        target_generation = ${targetGeneration === undefined ? 'target_generation' : getSqlLiteral(targetGeneration)},
        refresh_status = 'idle',
        last_error = NULL,
        worker_id = NULL,
        lease_expires_at = NULL,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)

    return getLargeRebuildStateRecord(tx, projectId)
  })
}

const claimLargeRebuilds = async ({leaseMs, limit, now, workerId}: ClaimLargeRebuildsParams): Promise<LargeRebuildClaim[]> => {
  if (limit <= 0) {
    return []
  }

  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const claimableRows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM app.project_mart_large_rebuild_state
    WHERE refresh_token > 0
      AND (
        refresh_status <> 'running'
        OR lease_expires_at IS NULL
        OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
      )
    ORDER BY refresh_token ASC, project_id ASC
    LIMIT ${Math.max(0, Math.floor(limit))}
  `)

  return claimableRows.reduce<Promise<LargeRebuildClaim[]>>(async (accPromise, row) => {
    const acc = await accPromise
    const [claimed] = await getAppDatabaseService().queryJson<LargeRebuildClaim>(`
      UPDATE app.project_mart_large_rebuild_state
      SET
        refresh_status = 'running',
        last_started_at = ${getTimestampLiteral(currentNow)},
        last_error = NULL,
        worker_id = ${getSqlLiteral(workerId)},
        lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(row.projectId)}
        AND refresh_token > 0
        AND (
          refresh_status <> 'running'
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
        )
      RETURNING
        project_id AS projectId,
        rebuild_phase AS rebuildPhase,
        CAST(refresh_token AS INTEGER) AS refreshToken,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt
    `)

    return claimed ? [...acc, claimed] : acc
  }, Promise.resolve([]))
}

const heartbeatLargeRebuildClaim = async ({leaseMs, now, projectId, workerId}: HeartbeatLargeRebuildClaimParams) => {
  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const [claim] = await getAppDatabaseService().queryJson<LargeRebuildClaim>(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
    RETURNING
      project_id AS projectId,
      rebuild_phase AS rebuildPhase,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt
  `)

  return claim ?? null
}

const completeLargeRebuild = async ({now, projectId, workerId}: CompleteLargeRebuildParams) => {
  const currentNow = getNow(now)
  const [completed] = await getAppDatabaseService().queryJson<LargeRebuildStateRow>(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_status = 'idle',
      last_completed_at = ${getTimestampLiteral(currentNow)},
      last_error = NULL,
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
    RETURNING
      project_id AS projectId,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      rebuild_phase AS rebuildPhase,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  return completed ? getLargeRebuildStateRecord(getAppDatabaseService(), projectId) : null
}

const failLargeRebuild = async ({error, now, projectId, workerId}: FailLargeRebuildParams) => {
  const currentNow = getNow(now)
  const [failed] = await getAppDatabaseService().queryJson<LargeRebuildStateRow>(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_status = 'failed',
      last_failed_at = ${getTimestampLiteral(currentNow)},
      last_error = ${getSqlLiteral(error)},
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND worker_id = ${getSqlLiteral(workerId)}
      AND refresh_status = 'running'
    RETURNING
      project_id AS projectId,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      rebuild_phase AS rebuildPhase,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  return failed ? getLargeRebuildStateRecord(getAppDatabaseService(), projectId) : null
}

const resetLargeRebuild = async ({cursorArticleCreatedAt, cursorArticleId, now, projectId, rebuildPhase, targetGeneration}: ResetLargeRebuildParams) => {
  const currentNow = getNow(now)

  await getAppDatabaseService().run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      rebuild_phase = ${rebuildPhase === undefined ? 'rebuild_phase' : getSqlLiteral(rebuildPhase)},
      cursor_article_created_at = ${cursorArticleCreatedAt === undefined || cursorArticleCreatedAt === null ? 'NULL' : getTimestampLiteral(cursorArticleCreatedAt)},
      cursor_article_id = ${getSqlLiteral(cursorArticleId ?? null)},
      target_generation = ${targetGeneration === undefined ? 'target_generation' : getSqlLiteral(targetGeneration)},
      refresh_status = 'idle',
      last_error = NULL,
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
  `)

  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const getLargeRebuildState = async (projectId: string) => {
  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const projectMartLargeRebuildStateService = {
  claimLargeRebuilds,
  completeLargeRebuild,
  failLargeRebuild,
  getLargeRebuildState,
  heartbeatLargeRebuildClaim,
  queueLargeRebuild,
  resetLargeRebuild,
}

export const getProjectMartLargeRebuildStateService = () => {
  return projectMartLargeRebuildStateService
}

export type {
  ClaimLargeRebuildsParams,
  CompleteLargeRebuildParams,
  FailLargeRebuildParams,
  HeartbeatLargeRebuildClaimParams,
  LargeRebuildClaim,
  QueueLargeRebuildParams,
  ResetLargeRebuildParams,
}

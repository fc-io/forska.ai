import type {
  ProjectMartLargeRebuildPhase,
  ProjectMartLargeRebuildStateRecord,
  ProjectMartRefreshStatus,
} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

type LargeRebuildStateRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

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

type ClaimLargeRebuildsParams = {leaseMs: number; limit: number; now?: Date; projectId?: string; workerId: string}

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

type ClearLargeRebuildStateParams = {projectId: string; runner?: LargeRebuildStateRunner}

type ClearArchivedLargeRebuildStatesParams = {runner?: LargeRebuildStateRunner}

type PauseLargeRebuildParams = {note?: string; now?: Date; projectId: string; reason?: string}
type ResumeLargeRebuildParams = {now?: Date; projectId: string}
type SetLargeRebuildOperatorNoteParams = {note: string | null; now?: Date; projectId: string}

type LargeRebuildStateRow = {
  createdAt: Date
  cursorArticleCreatedAt: Date | null
  cursorArticleId: string | null
  lastCompletedAt: Date | null
  lastError: string | null
  lastFailedAt: Date | null
  operatorNote: string | null
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

const withTransaction = async <T>(
  runner: LargeRebuildStateRunner | undefined,
  work: (tx: LargeRebuildStateRunner) => Promise<T>,
) => {
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
      operator_note AS operatorNote,
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

const getQueuedCursorArticleCreatedAtSql = ({
  cursorArticleCreatedAt,
  rebuildPhase,
}: {
  cursorArticleCreatedAt: Date | null | undefined
  rebuildPhase: ProjectMartLargeRebuildPhase
}) => {
  return cursorArticleCreatedAt !== undefined
    ? cursorArticleCreatedAt === null
      ? 'NULL'
      : getTimestampLiteral(cursorArticleCreatedAt)
    : `CASE WHEN rebuild_phase = ${getSqlLiteral(rebuildPhase)} THEN cursor_article_created_at ELSE NULL END`
}

const getQueuedCursorArticleIdSql = ({
  cursorArticleId,
  rebuildPhase,
}: {
  cursorArticleId: string | null | undefined
  rebuildPhase: ProjectMartLargeRebuildPhase
}) => {
  return cursorArticleId !== undefined
    ? getSqlLiteral(cursorArticleId)
    : `CASE WHEN rebuild_phase = ${getSqlLiteral(rebuildPhase)} THEN cursor_article_id ELSE NULL END`
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
    const queuedCursorArticleCreatedAtSql = getQueuedCursorArticleCreatedAtSql({cursorArticleCreatedAt, rebuildPhase})
    const queuedCursorArticleIdSql = getQueuedCursorArticleIdSql({cursorArticleId, rebuildPhase})

    await ensureLargeRebuildStateRow(tx, projectId)
    await tx.run(`
      UPDATE app.project_mart_large_rebuild_state
      SET
        refresh_token = GREATEST(refresh_token, ${refreshToken}),
        rebuild_phase = ${getSqlLiteral(rebuildPhase)},
        cursor_article_created_at = ${queuedCursorArticleCreatedAtSql},
        cursor_article_id = ${queuedCursorArticleIdSql},
        target_generation = ${targetGeneration === undefined ? 'target_generation' : getSqlLiteral(targetGeneration)},
        refresh_status = CASE WHEN refresh_status = 'paused' THEN 'paused' ELSE 'idle' END,
        last_error = NULL,
        worker_id = NULL,
        lease_expires_at = NULL,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)

    return getLargeRebuildStateRecord(tx, projectId)
  })
}

const claimLargeRebuilds = async ({
  leaseMs,
  limit,
  now,
  projectId,
  workerId,
}: ClaimLargeRebuildsParams): Promise<LargeRebuildClaim[]> => {
  if (limit <= 0) {
    return []
  }

  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const claimableRows = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT state.project_id AS projectId
    FROM app.project_mart_large_rebuild_state state
    INNER JOIN app.project project ON project.id = state.project_id
    WHERE project.archived = FALSE
      AND state.refresh_token > 0
      AND (${getSqlLiteral(projectId)} IS NULL OR state.project_id = ${getSqlLiteral(projectId)})
      AND (
        state.refresh_status IN ('idle', 'failed')
        OR (
          state.refresh_status = 'running'
          AND (
            state.lease_expires_at IS NULL
            OR state.lease_expires_at <= ${getTimestampLiteral(currentNow)}
          )
        )
      )
    ORDER BY state.last_started_at ASC NULLS FIRST, state.refresh_token ASC, state.project_id ASC
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
          refresh_status IN ('idle', 'failed')
          OR (
            refresh_status = 'running'
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
            )
          )
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
      refresh_token = 0,
      cursor_article_created_at = NULL,
      cursor_article_id = NULL,
      refresh_status = CASE WHEN refresh_status = 'paused' THEN 'paused' ELSE 'idle' END,
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
      operator_note AS operatorNote,
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
      operator_note AS operatorNote,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  return failed ? getLargeRebuildStateRecord(getAppDatabaseService(), projectId) : null
}

const resetLargeRebuild = async ({
  cursorArticleCreatedAt,
  cursorArticleId,
  now,
  projectId,
  rebuildPhase,
  targetGeneration,
}: ResetLargeRebuildParams) => {
  const currentNow = getNow(now)

  await getAppDatabaseService().run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      rebuild_phase = ${rebuildPhase === undefined ? 'rebuild_phase' : getSqlLiteral(rebuildPhase)},
      cursor_article_created_at = ${cursorArticleCreatedAt === undefined || cursorArticleCreatedAt === null ? 'NULL' : getTimestampLiteral(cursorArticleCreatedAt)},
      cursor_article_id = ${getSqlLiteral(cursorArticleId ?? null)},
      target_generation = ${targetGeneration === undefined ? 'target_generation' : getSqlLiteral(targetGeneration)},
      refresh_status = CASE WHEN refresh_status = 'paused' THEN 'paused' ELSE 'idle' END,
      last_error = CASE WHEN refresh_status = 'paused' THEN last_error ELSE NULL END,
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
  `)

  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const pauseLargeRebuild = async ({note, now, projectId, reason}: PauseLargeRebuildParams) => {
  const currentNow = getNow(now)

  await ensureLargeRebuildStateRow(getAppDatabaseService(), projectId)
  await getAppDatabaseService().run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_status = 'paused',
      last_error = ${getSqlLiteral(reason ?? 'Paused by operator')},
      operator_note = ${note === undefined ? 'operator_note' : getSqlLiteral(note)},
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
  `)

  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const resumeLargeRebuild = async ({now, projectId}: ResumeLargeRebuildParams) => {
  const currentNow = getNow(now)

  await ensureLargeRebuildStateRow(getAppDatabaseService(), projectId)
  await getAppDatabaseService().run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_status = 'idle',
      last_error = CASE WHEN last_error LIKE 'Paused by operator%' THEN NULL ELSE last_error END,
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
  `)

  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const setLargeRebuildOperatorNote = async ({note, now, projectId}: SetLargeRebuildOperatorNoteParams) => {
  const currentNow = getNow(now)

  await ensureLargeRebuildStateRow(getAppDatabaseService(), projectId)
  await getAppDatabaseService().run(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      operator_note = ${getSqlLiteral(note)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
  `)

  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const clearLargeRebuildState = async ({projectId, runner}: ClearLargeRebuildStateParams) => {
  return withTransaction(runner, async (tx) => {
    await tx.run(`
      DELETE FROM app.project_mart_large_rebuild_state
      WHERE project_id = ${getSqlLiteral(projectId)}
    `)
  })
}

const clearArchivedLargeRebuildStates = async ({runner}: ClearArchivedLargeRebuildStatesParams = {}) => {
  return withTransaction(runner, async (tx) => {
    await tx.run(`
      DELETE FROM app.project_mart_large_rebuild_state
      WHERE project_id IN (
        SELECT id
        FROM app.project
        WHERE archived = TRUE
      )
    `)
  })
}

const getLargeRebuildState = async (projectId: string) => {
  return getLargeRebuildStateRecord(getAppDatabaseService(), projectId)
}

const projectMartLargeRebuildStateService = {
  claimLargeRebuilds,
  clearArchivedLargeRebuildStates,
  clearLargeRebuildState,
  completeLargeRebuild,
  failLargeRebuild,
  getLargeRebuildState,
  heartbeatLargeRebuildClaim,
  pauseLargeRebuild,
  queueLargeRebuild,
  resetLargeRebuild,
  resumeLargeRebuild,
  setLargeRebuildOperatorNote,
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
  PauseLargeRebuildParams,
  QueueLargeRebuildParams,
  ResetLargeRebuildParams,
  ResumeLargeRebuildParams,
  SetLargeRebuildOperatorNoteParams,
}

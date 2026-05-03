import type {
  ProjectMartLargeRebuildPhase,
  ProjectMartLargeRebuildStateRecord,
  ProjectMartRefreshStatus,
} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getMaintenanceWorkLeaseService} from './maintenanceWorkLeaseService.ts'

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

type LargeRebuildFencedTransitionParams = {
  expectedRebuildPhase?: ProjectMartLargeRebuildPhase
  expectedRefreshToken?: number
  expectedTargetGeneration?: number | null
  projectId: string
  workerId?: string
}

type LargeRebuildClaim = {
  leaseExpiresAt: Date
  projectId: string
  rebuildPhase: ProjectMartLargeRebuildPhase
  refreshToken: number
  targetGeneration?: number | null
  workerId: string
}

type HeartbeatLargeRebuildClaimParams = LargeRebuildFencedTransitionParams & {
  leaseMs: number
  now?: Date
  workerId: string
}

type EnsureLargeRebuildTargetGenerationParams = LargeRebuildFencedTransitionParams & {
  now?: Date
  runner?: LargeRebuildStateRunner
}

type RecordLargeRebuildFrozenScopeParams = LargeRebuildFencedTransitionParams & {
  now?: Date
  runner?: LargeRebuildStateRunner
  workerId: string
}

type CompleteLargeRebuildParams = LargeRebuildFencedTransitionParams & {now?: Date; workerId: string}

type FailLargeRebuildParams = LargeRebuildFencedTransitionParams & {error: string; now?: Date; workerId: string}

type ResetLargeRebuildParams = {
  cursorArticleCreatedAt?: Date | null
  cursorArticleId?: string | null
  expectedRebuildPhase?: ProjectMartLargeRebuildPhase
  expectedRefreshToken?: number
  expectedTargetGeneration?: number | null
  now?: Date
  projectId: string
  rebuildPhase?: ProjectMartLargeRebuildPhase
  targetGeneration?: number | null
  workerId?: string
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
  sourceDirtyToken: number | null
  sourceHighWaterDirtyToken: number | null
  supersededAt: Date | null
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

const getExpectedTargetGenerationPredicateSql = (expectedTargetGeneration: number | null | undefined) => {
  return expectedTargetGeneration === undefined
    ? ''
    : `AND target_generation IS NOT DISTINCT FROM ${getSqlLiteral(expectedTargetGeneration)}`
}

const getFencedLargeRebuildStatePredicateSql = ({
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectId,
  workerId,
}: LargeRebuildFencedTransitionParams & {now: Date}) => {
  return `
      project_id = ${getSqlLiteral(projectId)}
      ${workerId === undefined ? '' : `AND worker_id = ${getSqlLiteral(workerId)}`}
      ${expectedRefreshToken === undefined ? '' : `AND refresh_token = ${expectedRefreshToken}`}
      ${expectedRebuildPhase === undefined ? '' : `AND rebuild_phase = ${getSqlLiteral(expectedRebuildPhase)}`}
      ${getExpectedTargetGenerationPredicateSql(expectedTargetGeneration)}
      AND superseded_at IS NULL
      ${
        workerId === undefined
          ? ''
          : `AND refresh_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > ${getTimestampLiteral(now)}`
      }
  `
}

const getLargeRebuildLeaseRecoveryContext = (claim: {
  rebuildPhase: ProjectMartLargeRebuildPhase
  refreshToken: number
  targetGeneration?: number | null
}) => {
  return {
    rebuildPhase: claim.rebuildPhase,
    refreshToken: claim.refreshToken,
    targetGeneration: claim.targetGeneration ?? null,
  }
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
      CAST(source_dirty_token AS INTEGER) AS sourceDirtyToken,
      CAST(source_high_water_dirty_token AS INTEGER) AS sourceHighWaterDirtyToken,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      operator_note AS operatorNote,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      superseded_at AS supersededAt,
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
        refresh_token = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN refresh_token
          ELSE ${refreshToken}
        END,
        rebuild_phase = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN rebuild_phase
          ELSE ${getSqlLiteral(rebuildPhase)}
        END,
        cursor_article_created_at = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN cursor_article_created_at
          ELSE ${queuedCursorArticleCreatedAtSql}
        END,
        cursor_article_id = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN cursor_article_id
          ELSE ${queuedCursorArticleIdSql}
        END,
        target_generation = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN target_generation
          ELSE ${targetGeneration === undefined ? 'NULL' : getSqlLiteral(targetGeneration)}
        END,
        source_dirty_token = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN source_dirty_token
          ELSE NULL
        END,
        source_high_water_dirty_token = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN source_high_water_dirty_token
          ELSE NULL
        END,
        superseded_at = NULL,
        refresh_status = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN refresh_status
          ELSE 'idle'
        END,
        last_error = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN last_error
          ELSE NULL
        END,
        worker_id = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN worker_id
          ELSE NULL
        END,
        lease_expires_at = CASE
          WHEN refresh_token > 0 AND refresh_status IN ('running', 'paused') THEN lease_expires_at
          ELSE NULL
        END,
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
      AND state.superseded_at IS NULL
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
        AND superseded_at IS NULL
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
        CAST(target_generation AS INTEGER) AS targetGeneration,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt
    `)

    if (!claimed) {
      return acc
    }

    await getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
      consumerId: workerId,
      leaseMs,
      now: currentNow,
      projectId: claimed.projectId,
      recoveryContext: getLargeRebuildLeaseRecoveryContext(claimed),
      requiredConsumerRole: 'maintenance-worker',
      scopeKind: 'project',
      workKind: 'review_index_large_rebuild',
    })

    return [...acc, claimed]
  }, Promise.resolve([]))
}

const heartbeatLargeRebuildClaim = async ({
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  leaseMs,
  now,
  projectId,
  workerId,
}: HeartbeatLargeRebuildClaimParams) => {
  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const [claim] = await getAppDatabaseService().queryJson<LargeRebuildClaim>(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE ${getFencedLargeRebuildStatePredicateSql({
      expectedRebuildPhase,
      expectedRefreshToken,
      expectedTargetGeneration,
      now: currentNow,
      projectId,
      workerId,
    })}
    RETURNING
      project_id AS projectId,
      rebuild_phase AS rebuildPhase,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt
  `)

  if (claim) {
    await getMaintenanceWorkLeaseService().progressMaintenanceWorkLease({
      consumerId: workerId,
      leaseMs,
      now: currentNow,
      projectId,
      recoveryContext: getLargeRebuildLeaseRecoveryContext(claim),
      requiredConsumerRole: 'maintenance-worker',
      scopeKind: 'project',
      workKind: 'review_index_large_rebuild',
    })
  }

  return claim ?? null
}

const ensureLargeRebuildTargetGeneration = async ({
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectId,
  runner,
  workerId,
}: EnsureLargeRebuildTargetGenerationParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)

    await tx.run(`
      INSERT INTO app.project_review_serving_generation (
        project_id,
        active_generation,
        generation_updated_at
      ) VALUES (
        ${getSqlLiteral(projectId)},
        0,
        current_timestamp
      ) ON CONFLICT(project_id) DO NOTHING
    `)
    await tx.run(`
      UPDATE app.project_mart_large_rebuild_state
      SET
        target_generation = COALESCE(
          target_generation,
          (
            SELECT active_generation + 1
            FROM app.project_review_serving_generation
            WHERE project_id = ${getSqlLiteral(projectId)}
          )
        ),
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE ${getFencedLargeRebuildStatePredicateSql({
        expectedRebuildPhase,
        expectedRefreshToken,
        expectedTargetGeneration,
        now: currentNow,
        projectId,
        workerId,
      })}
        AND refresh_token > 0
    `)

    return getLargeRebuildStateRecord(tx, projectId)
  })
}

const recordLargeRebuildFrozenScope = async ({
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectId,
  runner,
  workerId,
}: RecordLargeRebuildFrozenScopeParams) => {
  return withTransaction(runner, async (tx) => {
    const currentNow = getNow(now)
    const [recorded] = await tx.queryJson<LargeRebuildStateRow>(`
      UPDATE app.project_mart_large_rebuild_state
      SET
        source_dirty_token = COALESCE(source_dirty_token, refresh_token),
        source_high_water_dirty_token = COALESCE(
          source_high_water_dirty_token,
          (
            SELECT dirty_token
            FROM app.project_mart_refresh_state refresh_state
            WHERE refresh_state.project_id = ${getSqlLiteral(projectId)}
          ),
          refresh_token
        ),
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE ${getFencedLargeRebuildStatePredicateSql({
        expectedRebuildPhase,
        expectedRefreshToken,
        expectedTargetGeneration,
        now: currentNow,
        projectId,
        workerId,
      })}
      RETURNING
        project_id AS projectId,
        CAST(refresh_token AS INTEGER) AS refreshToken,
        rebuild_phase AS rebuildPhase,
        cursor_article_created_at AS cursorArticleCreatedAt,
        cursor_article_id AS cursorArticleId,
        CAST(target_generation AS INTEGER) AS targetGeneration,
        CAST(source_dirty_token AS INTEGER) AS sourceDirtyToken,
        CAST(source_high_water_dirty_token AS INTEGER) AS sourceHighWaterDirtyToken,
        refresh_status AS refreshStatus,
        last_started_at AS lastStartedAt,
        last_completed_at AS lastCompletedAt,
        last_failed_at AS lastFailedAt,
        last_error AS lastError,
        operator_note AS operatorNote,
        worker_id AS workerId,
        lease_expires_at AS leaseExpiresAt,
        superseded_at AS supersededAt,
        created_at AS createdAt,
        updated_at AS updatedAt
    `)

    return recorded ? getLargeRebuildStateRecord(tx, projectId) : null
  })
}

const completeLargeRebuild = async ({
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectId,
  workerId,
}: CompleteLargeRebuildParams) => {
  const currentNow = getNow(now)
  const [completed] = await getAppDatabaseService().queryJson<LargeRebuildStateRow>(`
    UPDATE app.project_mart_large_rebuild_state
    SET
      refresh_token = 0,
      cursor_article_created_at = NULL,
      cursor_article_id = NULL,
      target_generation = NULL,
      source_dirty_token = NULL,
      source_high_water_dirty_token = NULL,
      superseded_at = NULL,
      refresh_status = CASE WHEN refresh_status = 'paused' THEN 'paused' ELSE 'idle' END,
      last_completed_at = ${getTimestampLiteral(currentNow)},
      last_error = NULL,
      worker_id = NULL,
      lease_expires_at = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE ${getFencedLargeRebuildStatePredicateSql({
      expectedRebuildPhase,
      expectedRefreshToken,
      expectedTargetGeneration,
      now: currentNow,
      projectId,
      workerId,
    })}
    RETURNING
      project_id AS projectId,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      rebuild_phase AS rebuildPhase,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      CAST(source_dirty_token AS INTEGER) AS sourceDirtyToken,
      CAST(source_high_water_dirty_token AS INTEGER) AS sourceHighWaterDirtyToken,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      operator_note AS operatorNote,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      superseded_at AS supersededAt,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (completed) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_large_rebuild',
    })
  }

  return completed ? getLargeRebuildStateRecord(getAppDatabaseService(), projectId) : null
}

const failLargeRebuild = async ({
  error,
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectId,
  workerId,
}: FailLargeRebuildParams) => {
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
    WHERE ${getFencedLargeRebuildStatePredicateSql({
      expectedRebuildPhase,
      expectedRefreshToken,
      expectedTargetGeneration,
      now: currentNow,
      projectId,
      workerId,
    })}
    RETURNING
      project_id AS projectId,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      rebuild_phase AS rebuildPhase,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      CAST(source_dirty_token AS INTEGER) AS sourceDirtyToken,
      CAST(source_high_water_dirty_token AS INTEGER) AS sourceHighWaterDirtyToken,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      operator_note AS operatorNote,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      superseded_at AS supersededAt,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (failed) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_large_rebuild',
    })
  }

  return failed ? getLargeRebuildStateRecord(getAppDatabaseService(), projectId) : null
}

const resetLargeRebuild = async ({
  cursorArticleCreatedAt,
  cursorArticleId,
  expectedRebuildPhase,
  expectedRefreshToken,
  expectedTargetGeneration,
  now,
  projectId,
  rebuildPhase,
  targetGeneration,
  workerId,
}: ResetLargeRebuildParams) => {
  const currentNow = getNow(now)

  const [reset] = await getAppDatabaseService().queryJson<LargeRebuildStateRow>(`
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
    WHERE ${getFencedLargeRebuildStatePredicateSql({
      expectedRebuildPhase,
      expectedRefreshToken,
      expectedTargetGeneration,
      now: currentNow,
      projectId,
      workerId,
    })}
    RETURNING
      project_id AS projectId,
      CAST(refresh_token AS INTEGER) AS refreshToken,
      rebuild_phase AS rebuildPhase,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(target_generation AS INTEGER) AS targetGeneration,
      CAST(source_dirty_token AS INTEGER) AS sourceDirtyToken,
      CAST(source_high_water_dirty_token AS INTEGER) AS sourceHighWaterDirtyToken,
      refresh_status AS refreshStatus,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      operator_note AS operatorNote,
      worker_id AS workerId,
      lease_expires_at AS leaseExpiresAt,
      superseded_at AS supersededAt,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (reset) {
    await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
      consumerId: workerId,
      now: currentNow,
      projectId,
      scopeKind: 'project',
      workKind: 'review_index_large_rebuild',
    })
  }

  return reset ? getLargeRebuildStateRecord(getAppDatabaseService(), projectId) : null
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

  await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
    now: currentNow,
    projectId,
    scopeKind: 'project',
    workKind: 'review_index_large_rebuild',
  })

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
  ensureLargeRebuildTargetGeneration,
  failLargeRebuild,
  getLargeRebuildState,
  heartbeatLargeRebuildClaim,
  pauseLargeRebuild,
  queueLargeRebuild,
  recordLargeRebuildFrozenScope,
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
  EnsureLargeRebuildTargetGenerationParams,
  FailLargeRebuildParams,
  HeartbeatLargeRebuildClaimParams,
  LargeRebuildClaim,
  PauseLargeRebuildParams,
  QueueLargeRebuildParams,
  RecordLargeRebuildFrozenScopeParams,
  ResetLargeRebuildParams,
  ResumeLargeRebuildParams,
  SetLargeRebuildOperatorNoteParams,
}

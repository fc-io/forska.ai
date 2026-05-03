import type {ProjectMartDirtyMaterializationStateRecord} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

type DirtyMaterializationRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type DirtyMaterializationSourceSnapshot = {
  sourceScopeFingerprint?: string | null
  sourceScopeGeneration?: number | null
  sourceScopeHighWaterArticleCreatedAt?: Date | null
  sourceScopeHighWaterArticleId?: string | null
}

type QueueDirtyMaterializationParams = DirtyMaterializationSourceSnapshot & {
  now?: Date
  projectId: string
  runner?: DirtyMaterializationRunner
  sourceKind: string
  targetDirtyToken: number
}

type ClaimDirtyMaterializationsParams = {
  leaseMs: number
  limit: number
  now?: Date
  sourceKind?: string
  workerId: string
}

type DirtyMaterializationFence = DirtyMaterializationSourceSnapshot & {
  materializationOwner: string
  now?: Date
  projectId: string
  sourceKind: string
  targetDirtyToken: number
}

type HeartbeatDirtyMaterializationParams = DirtyMaterializationFence & {leaseMs: number}

type AdvanceDirtyMaterializationCursorParams = DirtyMaterializationFence & {
  cursorArticleCreatedAt?: Date | null
  cursorArticleId?: string | null
  insertedRowCountDelta: number
}

type CompleteDirtyMaterializationParams = DirtyMaterializationFence

type FailDirtyMaterializationParams = DirtyMaterializationFence & {error: string}

type GetCompletedDirtyMaterializationTokenParams = DirtyMaterializationSourceSnapshot & {
  projectId: string
  sourceKind: string
  targetDirtyToken: number
}

type DirtyMaterializationClaim = {
  leaseExpiresAt: Date
  materializationOwner: string
  projectId: string
  sourceKind: string
  sourceScopeFingerprint: string | null
  sourceScopeGeneration: number | null
  sourceScopeHighWaterArticleCreatedAt: Date | null
  sourceScopeHighWaterArticleId: string | null
  targetDirtyToken: number
}

type NormalizedDirtyMaterializationSourceSnapshot = {
  sourceScopeFingerprint: string | null
  sourceScopeGeneration: number | null
  sourceScopeHighWaterArticleCreatedAt: Date | null
  sourceScopeHighWaterArticleId: string | null
}

const getNow = (value?: Date) => {
  return value ?? new Date()
}

const getLeaseExpiry = (now: Date, leaseMs: number) => {
  return new Date(now.getTime() + leaseMs)
}

const getNormalizedLimit = (limit: number) => {
  return Math.max(0, Math.floor(limit))
}

const getNormalizedInsertedRowCountDelta = (insertedRowCountDelta: number) => {
  return Math.max(0, Math.floor(insertedRowCountDelta))
}

const getSourceSnapshot = (
  snapshot: DirtyMaterializationSourceSnapshot,
): NormalizedDirtyMaterializationSourceSnapshot => {
  return {
    sourceScopeFingerprint: snapshot.sourceScopeFingerprint ?? null,
    sourceScopeGeneration: snapshot.sourceScopeGeneration ?? null,
    sourceScopeHighWaterArticleCreatedAt: snapshot.sourceScopeHighWaterArticleCreatedAt ?? null,
    sourceScopeHighWaterArticleId: snapshot.sourceScopeHighWaterArticleId ?? null,
  }
}

const getSourceSnapshotFenceSql = (snapshot: DirtyMaterializationSourceSnapshot, tableAlias = '') => {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  const normalizedSnapshot = getSourceSnapshot(snapshot)

  return `
    AND ${prefix}source_scope_generation IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeGeneration)}
    AND ${prefix}source_scope_high_water_article_created_at IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeHighWaterArticleCreatedAt)}
    AND ${prefix}source_scope_high_water_article_id IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeHighWaterArticleId)}
    AND ${prefix}source_scope_fingerprint IS NOT DISTINCT FROM ${getSqlLiteral(normalizedSnapshot.sourceScopeFingerprint)}
  `
}

const getDirtyMaterializationStateSelectSql = () => {
  return `
    SELECT
      project_id AS projectId,
      source_kind AS sourceKind,
      CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      CAST(inserted_row_count AS INTEGER) AS insertedRowCount,
      CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
      source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
      source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
      source_scope_fingerprint AS sourceScopeFingerprint,
      materialization_status AS materializationStatus,
      materialization_owner AS materializationOwner,
      lease_expires_at AS leaseExpiresAt,
      last_started_at AS lastStartedAt,
      last_completed_at AS lastCompletedAt,
      last_failed_at AS lastFailedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project_mart_dirty_materialization_state
  `
}

const getDirtyMaterializationStateRecord = async (
  runner: DirtyMaterializationRunner,
  params: {projectId: string; sourceKind: string; targetDirtyToken: number},
) => {
  const [row] = await runner.queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    ${getDirtyMaterializationStateSelectSql()}
    WHERE project_id = ${getSqlLiteral(params.projectId)}
      AND source_kind = ${getSqlLiteral(params.sourceKind)}
      AND target_dirty_token = ${params.targetDirtyToken}
    LIMIT 1
  `)

  return row ?? null
}

const queueDirtyMaterialization = async ({
  now,
  projectId,
  runner,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: QueueDirtyMaterializationParams) => {
  const activeRunner = runner ?? getAppDatabaseService()
  const currentNow = getNow(now)
  const sourceSnapshot = getSourceSnapshot(snapshot)

  await activeRunner.run(`
    INSERT INTO app.project_mart_dirty_materialization_state (
      project_id,
      source_kind,
      target_dirty_token,
      source_scope_generation,
      source_scope_high_water_article_created_at,
      source_scope_high_water_article_id,
      source_scope_fingerprint,
      materialization_status,
      created_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(projectId)},
      ${getSqlLiteral(sourceKind)},
      ${targetDirtyToken},
      ${getSqlLiteral(sourceSnapshot.sourceScopeGeneration)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleCreatedAt)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeHighWaterArticleId)},
      ${getSqlLiteral(sourceSnapshot.sourceScopeFingerprint)},
      'pending',
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(currentNow)}
    )
    ON CONFLICT(project_id, source_kind, target_dirty_token) DO UPDATE SET
      source_scope_generation = EXCLUDED.source_scope_generation,
      source_scope_high_water_article_created_at = EXCLUDED.source_scope_high_water_article_created_at,
      source_scope_high_water_article_id = EXCLUDED.source_scope_high_water_article_id,
      source_scope_fingerprint = EXCLUDED.source_scope_fingerprint,
      materialization_status = 'pending',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = EXCLUDED.updated_at
  `)

  return getDirtyMaterializationStateRecord(activeRunner, {projectId, sourceKind, targetDirtyToken})
}

const claimDirtyMaterializations = async ({
  leaseMs,
  limit,
  now,
  sourceKind,
  workerId,
}: ClaimDirtyMaterializationsParams): Promise<DirtyMaterializationClaim[]> => {
  const normalizedLimit = getNormalizedLimit(limit)

  if (normalizedLimit === 0) {
    return []
  }

  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const claimableRows = await getAppDatabaseService().queryJson<DirtyMaterializationClaim>(`
    SELECT
      project_id AS projectId,
      source_kind AS sourceKind,
      CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
      CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
      source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
      source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
      source_scope_fingerprint AS sourceScopeFingerprint,
      ${getSqlLiteral(workerId)} AS materializationOwner,
      ${getTimestampLiteral(leaseExpiresAt)} AS leaseExpiresAt
    FROM app.project_mart_dirty_materialization_state
    WHERE (${getSqlLiteral(sourceKind ?? null)} IS NULL OR source_kind = ${getSqlLiteral(sourceKind ?? null)})
      AND (
        materialization_status IN ('pending', 'failed')
        OR (
          materialization_status = 'running'
          AND (
            lease_expires_at IS NULL
            OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
          )
        )
      )
    ORDER BY target_dirty_token ASC, project_id ASC, source_kind ASC
    LIMIT ${normalizedLimit}
  `)

  return claimableRows.reduce<Promise<DirtyMaterializationClaim[]>>(async (accPromise, row) => {
    const acc = await accPromise
    const [claimed] = await getAppDatabaseService().queryJson<DirtyMaterializationClaim>(`
      UPDATE app.project_mart_dirty_materialization_state
      SET
        materialization_status = 'running',
        materialization_owner = ${getSqlLiteral(workerId)},
        lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
        last_started_at = ${getTimestampLiteral(currentNow)},
        last_error = NULL,
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE project_id = ${getSqlLiteral(row.projectId)}
        AND source_kind = ${getSqlLiteral(row.sourceKind)}
        AND target_dirty_token = ${row.targetDirtyToken}
        ${getSourceSnapshotFenceSql(row)}
        AND (
          materialization_status IN ('pending', 'failed')
          OR (
            materialization_status = 'running'
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at <= ${getTimestampLiteral(currentNow)}
            )
          )
        )
      RETURNING
        project_id AS projectId,
        source_kind AS sourceKind,
        CAST(target_dirty_token AS INTEGER) AS targetDirtyToken,
        CAST(source_scope_generation AS INTEGER) AS sourceScopeGeneration,
        source_scope_high_water_article_created_at AS sourceScopeHighWaterArticleCreatedAt,
        source_scope_high_water_article_id AS sourceScopeHighWaterArticleId,
        source_scope_fingerprint AS sourceScopeFingerprint,
        materialization_owner AS materializationOwner,
        lease_expires_at AS leaseExpiresAt
    `)

    return claimed ? [...acc, claimed] : acc
  }, Promise.resolve([]))
}

const getClaimedDirtyMaterialization = async ({
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: DirtyMaterializationFence) => {
  const currentNow = getNow(now)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    ${getDirtyMaterializationStateSelectSql()}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    LIMIT 1
  `)

  return row ?? null
}

const heartbeatDirtyMaterialization = async ({
  leaseMs,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: HeartbeatDirtyMaterializationParams) => {
  const currentNow = getNow(now)
  const leaseExpiresAt = getLeaseExpiry(currentNow, leaseMs)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      lease_expires_at = ${getTimestampLiteral(leaseExpiresAt)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const advanceDirtyMaterializationCursor = async ({
  cursorArticleCreatedAt,
  cursorArticleId,
  insertedRowCountDelta,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: AdvanceDirtyMaterializationCursorParams) => {
  const currentNow = getNow(now)
  const normalizedInsertedRowCountDelta = getNormalizedInsertedRowCountDelta(insertedRowCountDelta)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      cursor_article_created_at = ${cursorArticleCreatedAt === undefined ? 'cursor_article_created_at' : getSqlLiteral(cursorArticleCreatedAt)},
      cursor_article_id = ${cursorArticleId === undefined ? 'cursor_article_id' : getSqlLiteral(cursorArticleId)},
      inserted_row_count = inserted_row_count + ${normalizedInsertedRowCountDelta},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const completeDirtyMaterialization = async ({
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: CompleteDirtyMaterializationParams) => {
  const currentNow = getNow(now)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'completed',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_completed_at = ${getTimestampLiteral(currentNow)},
      last_error = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const failDirtyMaterialization = async ({
  error,
  materializationOwner,
  now,
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: FailDirtyMaterializationParams) => {
  const currentNow = getNow(now)
  const [row] = await getAppDatabaseService().queryJson<ProjectMartDirtyMaterializationStateRecord>(`
    UPDATE app.project_mart_dirty_materialization_state
    SET
      materialization_status = 'failed',
      materialization_owner = NULL,
      lease_expires_at = NULL,
      last_failed_at = ${getTimestampLiteral(currentNow)},
      last_error = ${getSqlLiteral(error)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'running'
      AND materialization_owner = ${getSqlLiteral(materializationOwner)}
      AND lease_expires_at > ${getTimestampLiteral(currentNow)}
    RETURNING *
  `)

  return row
    ? getDirtyMaterializationStateRecord(getAppDatabaseService(), {projectId, sourceKind, targetDirtyToken})
    : null
}

const getCompletedDirtyMaterializationToken = async ({
  projectId,
  sourceKind,
  targetDirtyToken,
  ...snapshot
}: GetCompletedDirtyMaterializationTokenParams) => {
  const [row] = await getAppDatabaseService().queryJson<{targetDirtyToken: number}>(`
    SELECT CAST(target_dirty_token AS INTEGER) AS targetDirtyToken
    FROM app.project_mart_dirty_materialization_state
    WHERE project_id = ${getSqlLiteral(projectId)}
      AND source_kind = ${getSqlLiteral(sourceKind)}
      AND target_dirty_token = ${targetDirtyToken}
      ${getSourceSnapshotFenceSql(snapshot)}
      AND materialization_status = 'completed'
    LIMIT 1
  `)

  return row?.targetDirtyToken ?? null
}

const projectMartDirtyMaterializationService = {
  advanceDirtyMaterializationCursor,
  claimDirtyMaterializations,
  completeDirtyMaterialization,
  failDirtyMaterialization,
  getClaimedDirtyMaterialization,
  getCompletedDirtyMaterializationToken,
  queueDirtyMaterialization,
  heartbeatDirtyMaterialization,
}

export const getProjectMartDirtyMaterializationService = () => {
  return projectMartDirtyMaterializationService
}

export type {
  AdvanceDirtyMaterializationCursorParams,
  ClaimDirtyMaterializationsParams,
  CompleteDirtyMaterializationParams,
  DirtyMaterializationClaim,
  DirtyMaterializationFence,
  DirtyMaterializationSourceSnapshot,
  FailDirtyMaterializationParams,
  GetCompletedDirtyMaterializationTokenParams,
  HeartbeatDirtyMaterializationParams,
  QueueDirtyMaterializationParams,
}

import {createHash, randomUUID} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  advanceReviewServingProjectorWatermark,
  assertReviewServingProjectorWatermarkCanAdvance,
  type ReviewServingProjectorWatermarkAdvanceInput,
} from './reviewServingDeltaReconciliation.ts'
import {getReviewServingJsonRowsSql} from './reviewServingJsonRowSource.ts'
import {getReviewServingDirtyWorkScopeKey, type ReviewServingDirtyWorkScope} from './reviewServingProjectorDomain.ts'

export type ReviewServingDirtyWorkStatus = 'blocked_by_rebuild' | 'completed' | 'failed' | 'pending' | 'running'

export type ReviewServingDirtyWorkLifecycleReason =
  | 'blocked_by_rebuild'
  | 'covered_by_rebuild'
  | 'failed'
  | 'orphan_missing_component'
  | 'projected'
  | 'released'
  | 'repartitioned'
  | 'superseded_by_high_water'

export type ReviewServingDirtyWorkDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingDirtyWorkTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingDirtyWorkTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingDirtyWorkInput = {
  articleId?: string | null
  latestDeltaId?: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  scope: ReviewServingDirtyWorkScope
}

export type ReviewServingDirtyWorkClaimOrder = 'newest' | 'oldest'

export type ClaimReviewServingDirtyWorkParams = {
  claimOrder?: ReviewServingDirtyWorkClaimOrder
  limit: number
  maxWakeCount?: number
  now?: Date
  projectionComponent: ReviewServingProjectionComponent
  staleRunningClaimSeconds?: number
}

export const defaultReviewServingDirtyWorkStaleClaimSeconds = 15 * 60
export const defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds = 60 * 60
const reviewServingDirtyWorkLaneWindowLimit = 2_048
const reviewServingDirtyWorkCoverageCompletionLimit = 2_048

const newestFirstDirtyWorkSourceKey = 'import-route'

const getLaneWindowLimit = (limit: number) => {
  return Math.max(reviewServingDirtyWorkLaneWindowLimit, limit * 2)
}

export const isReviewServingDirtyWorkNewestFirstSourcePartition = (sourcePartition: string) => {
  return sourcePartition.split(':')[0] === newestFirstDirtyWorkSourceKey
}

export type RequeueReviewServingDirtyWorkBlockedByRebuildParams = {
  limit: number
  minBlockedSeconds?: number
  now?: Date
}

export type CleanupReviewServingDirtyWorkRetentionParams = {
  blockedByRebuildRequeueLimit?: number
  coalesceDirtyWorkLimit?: number
  completedRetentionSeconds?: number
  dirtyWorkDeleteLimit?: number
  laneRepairLimit?: number
  laneStateRepairLimit?: number
  now?: Date
  orphanCompletionLimit?: number
}

export type CleanupReviewServingDirtyWorkRetentionResult = {
  coalescedDirtyWorkCount?: number
  completedOrphanDirtyWorkCount?: number
  deletedDirtyWorkCount: number
  repairedLaneColumnCount?: number
  repairedLaneStateCount?: number
  requeuedBlockedByRebuildCount?: number
}

export type ReviewServingDirtyWorkCoverage = {
  completedSourceHighWaterMark: number
  projectId: string
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  sourcePartition: string
}

export type CompleteReviewServingDirtyWorkCoverageResult = {completedCount: number}

export type ReviewServingDirtyWorkClaim = {
  articleId: string | null
  dirtyKind: string
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string
  firstSourceHighWaterMark: number
  latestDeltaId: string | null
  latestSourceHighWaterMark: number
  lifecycleReason?: ReviewServingDirtyWorkLifecycleReason | null
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  scopeId: string
  scopeKind: string
  sourcePartition: string
  status: ReviewServingDirtyWorkStatus
  storageRowId?: number | string | null
}

export type ReviewServingDirtyWorkRecord = ReviewServingDirtyWorkClaim & {
  createdAt: Date | null
  updatedAt: Date | null
}

export type ReviewServingDirtyWorkUpsertResult = {dirtyWorkId: string; skipped: boolean}

type DirtyWorkRow = {
  articleId: string | null
  createdAt: unknown
  dirtyKind: string
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string
  firstSourceHighWaterMark: number
  latestDeltaId: string | null
  latestSourceHighWaterMark: number
  lifecycleReason?: ReviewServingDirtyWorkLifecycleReason | null
  projectId: string | null
  projectionComponent?: ReviewServingProjectionComponent | null
  projectionIdentity?: string | null
  projectionKey: string | null
  scopeId: string
  scopeKind: string
  sourcePartition: string
  status: ReviewServingDirtyWorkStatus
  storageRowId?: number | string | null
  updatedAt: unknown
}

type DirtyWorkSourceWatermarkCompletion = {
  projectId: string | null
  sourceHighWaterMark: number
  sourcePartition: string
}

type DirtyWorkClaimStateRow = {
  claimStateRowId?: number | string | null
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string
  latestSourceHighWaterMark: number
  projectId: string
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  sourcePartition: string
  status: ReviewServingDirtyWorkStatus
  storageRowId: number | string | null
  updatedAt: unknown
}

const getReviewServingHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getProjectionKey = (input: {
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
}) => {
  return getStableReviewServingJson(input)
}

const getProjectionComponentSql = (dirtyWorkSql: string) => {
  return `${dirtyWorkSql}.projection_component`
}

const getProjectionIdentitySql = (dirtyWorkSql: string) => {
  return `${dirtyWorkSql}.projection_identity`
}

export const getReviewServingDirtyWorkActiveProjectPredicate = (projectIdSql: string) => {
  return `(
      ${projectIdSql} = ''
      OR EXISTS (
        SELECT 1
        FROM app.project project
        WHERE project.id = ${projectIdSql}
          AND project.archived = FALSE
          AND project.delete_pending_at IS NULL
      )
    )`
}

const getRebuildRequestCoversComponentPredicate = (requestAlias: string, projectionComponentSql: string) => {
  return `EXISTS (
            SELECT 1
            FROM json_each(${requestAlias}.requested_components_json) requested_component
            WHERE json_extract_string(requested_component.value, '$') = ${projectionComponentSql}
          )`
}

const getEligibleDirtyWorkPredicate = (params: ClaimReviewServingDirtyWorkParams, claimNowSql: string) => {
  const staleRunningClaimSeconds = getStaleRunningClaimSeconds(params)

  return `(
      status = 'pending'
      OR (
        status = 'running'
        AND updated_at <= ${claimNowSql} - INTERVAL '${staleRunningClaimSeconds} seconds'
      )
      OR (
        status = 'failed'
        AND updated_at <= ${claimNowSql} - INTERVAL '${staleRunningClaimSeconds} seconds'
      )
    )
    AND projection_component = ${getSqlLiteral(params.projectionComponent)}`
}

const getEligibleDirtyWorkClaimStatePredicate = (
  params: ClaimReviewServingDirtyWorkParams,
  claimNowSql: string,
  claimStateSql: string,
) => {
  return `${claimStateSql}.projection_component = ${getSqlLiteral(params.projectionComponent)}
        AND (
          ${claimStateSql}.status = 'pending'
          OR (
            ${claimStateSql}.status IN ('running', 'failed')
            AND ${claimStateSql}.updated_at <= ${claimNowSql} - INTERVAL '${getStaleRunningClaimSeconds(params)} seconds'
          )
        )`
}

const getServedDirtyWorkClaimStatePredicate = (
  params: ClaimReviewServingDirtyWorkParams,
  claimNowSql: string,
  claimStateSql: string,
) => {
  return `${claimStateSql}.projection_component = ${getSqlLiteral(params.projectionComponent)}
        AND ${claimStateSql}.updated_at >= ${claimNowSql} - INTERVAL '${servedDirtyWorkLookbackDays} days'
        AND (
          ${claimStateSql}.status <> 'pending'
          OR ${claimStateSql}.lifecycle_reason = 'released'
        )
        AND COALESCE(${claimStateSql}.lifecycle_reason, '') NOT IN ('superseded_by_high_water', 'orphan_missing_component')`
}

const getDirtyWorkId = (input: ReviewServingDirtyWorkInput) => {
  return `dirtyWork:${getReviewServingHash('review-serving-dirty-work', {
    projectionKey: getProjectionKey({
      projectionComponent: input.projectionComponent,
      projectionIdentity: input.projectionIdentity,
    }),
    scopeKey: getReviewServingDirtyWorkScopeKey(input.scope),
  }).slice(0, 32)}`
}

const getNormalizedLimit = (params: {limit: number; maxWakeCount?: number}) => {
  const limit = Math.max(0, Math.floor(params.limit))
  const maxWakeCount = params.maxWakeCount === undefined ? limit : Math.max(0, Math.floor(params.maxWakeCount))

  return Math.min(limit, maxWakeCount)
}

const defaultLaneRepairLimit = 256
const defaultLaneStateRepairLimit = 256
const defaultBlockedByRebuildRequeueLimit = 256
const defaultCoalesceDirtyWorkLimit = 2_000
const defaultOrphanCompletionLimit = 2_000
const orphanDirtyWorkMinAgeSeconds = 60 * 60
const servedDirtyWorkLookbackDays = 7
// Completed rows are deleted together with their claim state and id reservation after this long; a later change to
// the same projection inserts a fresh row. Diagnostics look back 10 minutes, and fair project rotation only needs to
// know who was served within the hour.
export const defaultCompletedDirtyWorkRetentionSeconds = 60 * 60
const defaultCompletedDirtyWorkDeleteLimit = 20_000

const getNormalizedCleanupLimit = (value: number | undefined, fallback: number) => {
  return Math.max(0, Math.floor(value ?? fallback))
}

const getNormalizedDirtyWorkCoverages = (coverages: readonly ReviewServingDirtyWorkCoverage[]) => {
  const normalized = coverages
    .map((coverage) => {
      return {...coverage, completedSourceHighWaterMark: Math.max(0, Math.floor(coverage.completedSourceHighWaterMark))}
    })
    .filter((coverage) => {
      return (
        coverage.projectId.trim().length > 0
        && coverage.projectionIdentity.trim().length > 0
        && coverage.sourcePartition.trim().length > 0
      )
    })

  return [...normalized.values()].reduce<ReviewServingDirtyWorkCoverage[]>((merged, coverage) => {
    const existingIndex = merged.findIndex((candidate) => {
      return (
        candidate.projectId === coverage.projectId
        && candidate.projectionComponent === coverage.projectionComponent
        && candidate.projectionIdentity === coverage.projectionIdentity
        && candidate.sourcePartition === coverage.sourcePartition
      )
    })

    if (existingIndex === -1) {
      return [...merged, coverage]
    }

    return merged.map((candidate, index) => {
      return index === existingIndex
        ? {
            ...candidate,
            completedSourceHighWaterMark: Math.max(
              candidate.completedSourceHighWaterMark,
              coverage.completedSourceHighWaterMark,
            ),
          }
        : candidate
    })
  }, [])
}

const getStaleRunningClaimSeconds = (params: ClaimReviewServingDirtyWorkParams) => {
  return Math.max(0, Math.floor(params.staleRunningClaimSeconds ?? defaultReviewServingDirtyWorkStaleClaimSeconds))
}

const getNowSql = (now: Date | undefined) => {
  return now === undefined ? 'current_timestamp' : `TIMESTAMPTZ ${getSqlLiteral(now.toISOString())}`
}

const getClaimNowSql = (params: ClaimReviewServingDirtyWorkParams) => {
  return getNowSql(params.now)
}

const getClaimNowMs = (params: ClaimReviewServingDirtyWorkParams) => {
  return (params.now ?? new Date()).getTime()
}

const dirtyWorkClaimStateUpdatedAtMsByRow = new WeakMap<DirtyWorkClaimStateRow, number>()

const getDirtyWorkClaimStateUpdatedAtMs = (row: DirtyWorkClaimStateRow) => {
  const cachedMs = dirtyWorkClaimStateUpdatedAtMsByRow.get(row)

  if (cachedMs !== undefined) {
    return cachedMs
  }

  const value = getDateValue(row.updatedAt)
  const updatedAtMs = value === null ? 0 : value.getTime()

  dirtyWorkClaimStateUpdatedAtMsByRow.set(row, updatedAtMs)
  return updatedAtMs
}

const isDirtyWorkClaimStateEligible = (params: ClaimReviewServingDirtyWorkParams, row: DirtyWorkClaimStateRow) => {
  if (row.status === 'pending') {
    return true
  }

  return (
    (row.status === 'running' || row.status === 'failed')
    && getDirtyWorkClaimStateUpdatedAtMs(row) <= getClaimNowMs(params) - getStaleRunningClaimSeconds(params) * 1000
  )
}

const compareDirtyWorkClaimStateRows = (left: DirtyWorkClaimStateRow, right: DirtyWorkClaimStateRow) => {
  return (
    getDirtyWorkClaimStateUpdatedAtMs(left) - getDirtyWorkClaimStateUpdatedAtMs(right)
    || Number(left.latestSourceHighWaterMark) - Number(right.latestSourceHighWaterMark)
    || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
  )
}

const compareNewestDirtyWorkClaimStateRows = (left: DirtyWorkClaimStateRow, right: DirtyWorkClaimStateRow) => {
  return (
    Number(right.latestSourceHighWaterMark) - Number(left.latestSourceHighWaterMark)
    || getDirtyWorkClaimStateUpdatedAtMs(right) - getDirtyWorkClaimStateUpdatedAtMs(left)
    || right.dirtyWorkId.localeCompare(left.dirtyWorkId)
  )
}

const getClaimStateRowComparator = (claimOrder: ReviewServingDirtyWorkClaimOrder) => {
  return claimOrder === 'newest' ? compareNewestDirtyWorkClaimStateRows : compareDirtyWorkClaimStateRows
}

const getDirtyWorkClaimStateLaneKey = (
  row: Pick<DirtyWorkClaimStateRow, 'projectId' | 'projectionComponent' | 'projectionIdentity' | 'sourcePartition'>,
) => {
  return JSON.stringify([row.projectId, row.projectionComponent, row.projectionIdentity, row.sourcePartition])
}

// A candidate waits while an unexpired running or failed claim in its lane sits at a lower watermark. Keeping only
// the lowest such watermark per lane answers that in one pass; comparing every candidate with every window row was
// quadratic and took ~3.7 s of JavaScript inside the claim transaction for a 4,096-claim batch.
const getDirtyWorkClaimStateBlockingWatermarkByLane = (
  rows: readonly DirtyWorkClaimStateRow[],
  staleCutoffMs: number,
) => {
  const blockingWatermarkByLane = new Map<string, number>()

  rows.forEach((row) => {
    const watermark = Number(row.latestSourceHighWaterMark)

    if (
      (row.status !== 'running' && row.status !== 'failed')
      || getDirtyWorkClaimStateUpdatedAtMs(row) <= staleCutoffMs
      || Number.isNaN(watermark)
    ) {
      return
    }

    const laneKey = getDirtyWorkClaimStateLaneKey(row)
    const currentWatermark = blockingWatermarkByLane.get(laneKey)

    if (currentWatermark === undefined || watermark < currentWatermark) {
      blockingWatermarkByLane.set(laneKey, watermark)
    }
  })

  return blockingWatermarkByLane
}

const getClaimableDirtyWorkClaimStateRows = (
  params: ClaimReviewServingDirtyWorkParams,
  window: {claimOrder: ReviewServingDirtyWorkClaimOrder; rows: readonly DirtyWorkClaimStateRow[]},
  limit: number,
) => {
  const claimStateRows = window.rows
  const compareRows = getClaimStateRowComparator(window.claimOrder)
  const eligibleRows = claimStateRows.filter((row) => {
    return (
      row.projectionComponent === params.projectionComponent
      && (row.status === 'pending' || row.status === 'running' || row.status === 'failed')
      && isDirtyWorkClaimStateEligible(params, row)
    )
  })
  const [first] = [...eligibleRows].sort(compareRows)

  if (first === undefined) {
    return []
  }

  const staleCutoffMs = getClaimNowMs(params) - getStaleRunningClaimSeconds(params) * 1000
  const blockingWatermarkByLane = getDirtyWorkClaimStateBlockingWatermarkByLane(claimStateRows, staleCutoffMs)

  return eligibleRows
    .filter((candidate) => {
      const blockingWatermark = blockingWatermarkByLane.get(getDirtyWorkClaimStateLaneKey(candidate))

      return (
        candidate.projectId === first.projectId
        && candidate.projectionComponent === first.projectionComponent
        && candidate.projectionIdentity === first.projectionIdentity
        && candidate.sourcePartition === first.sourcePartition
        && !(blockingWatermark !== undefined && blockingWatermark < Number(candidate.latestSourceHighWaterMark))
      )
    })
    .sort(compareRows)
    .slice(0, limit)
}

const getArticleId = (input: ReviewServingDirtyWorkInput) => {
  const explicitArticleId = input.articleId?.trim()

  return explicitArticleId && explicitArticleId.length > 0
    ? explicitArticleId
    : input.scope.scopeKind === 'article'
      ? (input.scope.scopeId.split(':').at(-1) ?? null)
      : null
}

const reserveReviewServingDirtyWorkId = async (dirtyWorkId: string, database: ReviewServingDirtyWorkTransaction) => {
  const rows = await database.queryJson<{dirtyWorkId: string}>(`
    SELECT dirty_work_id AS dirtyWorkId
    FROM app.review_serving_dirty_work_id_lookup
    WHERE dirty_work_id = ${getSqlLiteral(dirtyWorkId)}
    LIMIT 1
  `)

  if (rows.length > 0) {
    return false
  }

  await database.run(`
    INSERT INTO app.review_serving_dirty_work_id_lookup (dirty_work_id)
    VALUES (${getSqlLiteral(dirtyWorkId)})
  `)

  return true
}

const getProjectionFromKey = (projectionKey: string | null) => {
  if (projectionKey === null) {
    return null
  }

  const parsed = JSON.parse(projectionKey) as {
    projectionComponent?: ReviewServingProjectionComponent
    projectionIdentity?: string
  }

  return parsed.projectionComponent === undefined || parsed.projectionIdentity === undefined ? null : parsed
}

const getDirtyWorkRecordFromRow = (row: DirtyWorkRow): ReviewServingDirtyWorkRecord => {
  const projection = getProjectionFromKey(row.projectionKey)

  return {
    articleId: row.articleId,
    createdAt: getDateValue(row.createdAt),
    dirtyKind: row.dirtyKind,
    dirtyRangeEnd: row.dirtyRangeEnd,
    dirtyRangeStart: row.dirtyRangeStart,
    dirtyWorkId: row.dirtyWorkId,
    firstSourceHighWaterMark: Number(row.firstSourceHighWaterMark),
    latestDeltaId: row.latestDeltaId,
    latestSourceHighWaterMark: Number(row.latestSourceHighWaterMark),
    lifecycleReason: row.lifecycleReason ?? null,
    projectId: row.projectId,
    projectionComponent: row.projectionComponent ?? projection?.projectionComponent ?? 'display',
    projectionIdentity: row.projectionIdentity ?? projection?.projectionIdentity ?? '',
    scopeId: row.scopeId,
    scopeKind: row.scopeKind,
    sourcePartition: row.sourcePartition,
    status: row.status,
    storageRowId: row.storageRowId ?? null,
    updatedAt: getDateValue(row.updatedAt),
  }
}

const getStorageRowIdSql = (storageRowId: number | string) => {
  return typeof storageRowId === 'number' ? String(storageRowId) : `CAST(${getSqlLiteral(storageRowId)} AS BIGINT)`
}

const getDirtyWorkSelect = () => {
  return `
    SELECT
      rowid AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.review_serving_dirty_work
  `
}

const getQualifiedDirtyWorkSelect = (dirtyWorkSql: string) => {
  return `
    SELECT
      ${dirtyWorkSql}.rowid AS storageRowId,
      ${dirtyWorkSql}.dirty_work_id AS dirtyWorkId,
      ${dirtyWorkSql}.project_id AS projectId,
      ${dirtyWorkSql}.scope_kind AS scopeKind,
      ${dirtyWorkSql}.scope_id AS scopeId,
      ${dirtyWorkSql}.article_id AS articleId,
      ${dirtyWorkSql}.projection_key AS projectionKey,
      ${dirtyWorkSql}.dirty_kind AS dirtyKind,
      ${dirtyWorkSql}.source_partition AS sourcePartition,
      ${dirtyWorkSql}.first_source_high_water_mark AS firstSourceHighWaterMark,
      ${dirtyWorkSql}.latest_source_high_water_mark AS latestSourceHighWaterMark,
      ${dirtyWorkSql}.lifecycle_reason AS lifecycleReason,
      ${dirtyWorkSql}.latest_delta_id AS latestDeltaId,
      ${dirtyWorkSql}.dirty_range_start AS dirtyRangeStart,
      ${dirtyWorkSql}.dirty_range_end AS dirtyRangeEnd,
      ${dirtyWorkSql}.projection_component AS projectionComponent,
      ${dirtyWorkSql}.projection_identity AS projectionIdentity,
      ${dirtyWorkSql}.status,
      ${dirtyWorkSql}.created_at AS createdAt,
      ${dirtyWorkSql}.updated_at AS updatedAt
    FROM app.review_serving_dirty_work ${dirtyWorkSql}
  `
}

const advanceReviewServingDirtySourceWatermarkEntries = async (
  entries: readonly DirtyWorkSourceWatermarkCompletion[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const projectEntries = entries.filter((entry): entry is DirtyWorkSourceWatermarkCompletion & {projectId: string} => {
    return entry.projectId !== null
  })

  if (projectEntries.length === 0) {
    return
  }

  const valuesSql = projectEntries
    .map((entry) => {
      return `(${getSqlLiteral(entry.projectId)}, ${getSqlLiteral(entry.sourcePartition)}, ${getSqlLiteral(
        entry.sourceHighWaterMark,
      )})`
    })
    .join(',\n      ')

  const completedWatermarksSql = `
    SELECT
      project_id,
      source_partition,
      MAX(source_high_water_mark) AS source_high_water_mark,
      current_timestamp AS updated_at
    FROM (
      VALUES
      ${valuesSql}
    ) AS completed(project_id, source_partition, source_high_water_mark)
    GROUP BY project_id, source_partition
  `

  await database.run(`
    UPDATE app.review_serving_project_dirty_source_watermark existing
    SET
      source_high_water_mark = GREATEST(existing.source_high_water_mark, completed.source_high_water_mark),
      updated_at = CASE
        WHEN completed.source_high_water_mark > existing.source_high_water_mark
          THEN completed.updated_at
        ELSE existing.updated_at
      END
    FROM (
      ${completedWatermarksSql}
    ) AS completed
    WHERE existing.project_id = completed.project_id
      AND existing.source_partition = completed.source_partition
  `)

  await database.run(`
    INSERT INTO app.review_serving_project_dirty_source_watermark (
      project_id,
      source_partition,
      source_high_water_mark,
      updated_at
    )
    SELECT
      completed.project_id,
      completed.source_partition,
      completed.source_high_water_mark,
      completed.updated_at
    FROM (
      ${completedWatermarksSql}
    ) AS completed
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_project_dirty_source_watermark existing
      WHERE existing.project_id = completed.project_id
        AND existing.source_partition = completed.source_partition
    )
  `)
}

const advanceReviewServingDirtySourceWatermark = async (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  await advanceReviewServingDirtySourceWatermarkEntries(
    claims.map((claim) => {
      return {
        projectId: claim.projectId,
        sourceHighWaterMark: claim.latestSourceHighWaterMark,
        sourcePartition: claim.sourcePartition,
      }
    }),
    database,
  )
}

const getDirtyWorkCoverageValuesSql = (coverages: readonly ReviewServingDirtyWorkCoverage[]) => {
  return coverages
    .map((coverage) => {
      return `(
        ${getSqlLiteral(coverage.projectId)},
        ${getSqlLiteral(
          getProjectionKey({
            projectionComponent: coverage.projectionComponent,
            projectionIdentity: coverage.projectionIdentity,
          }),
        )},
        ${getSqlLiteral(coverage.projectionComponent)},
        ${getSqlLiteral(coverage.projectionIdentity)},
        ${getSqlLiteral(coverage.sourcePartition)},
        ${getSqlLiteral(coverage.completedSourceHighWaterMark)}
      )`
    })
    .join(',\n      ')
}

const getDirtyWorkCoverageCteSql = (coverages: readonly ReviewServingDirtyWorkCoverage[]) => {
  return `
    SELECT
      project_id,
      projection_key,
      projection_component,
      projection_identity,
      source_partition,
      MAX(completed_source_high_water_mark) AS completed_source_high_water_mark
    FROM (
      VALUES
      ${getDirtyWorkCoverageValuesSql(coverages)}
    ) AS coverage(
      project_id,
      projection_key,
      projection_component,
      projection_identity,
      source_partition,
      completed_source_high_water_mark
    )
    GROUP BY project_id, projection_key, projection_component, projection_identity, source_partition
  `
}

const getDirtyWorkSourceWatermarkKeySql = (sourcePartitionSql: string) => {
  const sourceKeySql = `split_part(${sourcePartitionSql}, ':', 1)`

  return `CASE ${sourceKeySql}
    WHEN 'humanJudgment' THEN 'reviewChange'
    WHEN 'import-run-article' THEN 'importRunArticle'
    WHEN 'importRoute' THEN 'importRunArticle'
    WHEN 'llmJudgment' THEN 'reviewChange'
    WHEN 'projectReviewConfig' THEN 'reviewChange'
    WHEN 'project-scope' THEN 'projectScope'
    WHEN 'promptConfig' THEN 'reviewChange'
    WHEN 'review-change' THEN 'reviewChange'
    ELSE ${sourceKeySql}
  END`
}

const getDirtyWorkCoverageMatchSql = (dirtyWorkSql: string) => {
  const sourceKeySql = `split_part(${dirtyWorkSql}.source_partition, ':', 1)`

  return `
    ${dirtyWorkSql}.project_id = coverage.project_id
    AND ${getProjectionComponentSql(dirtyWorkSql)} = coverage.projection_component
    AND ${getProjectionIdentitySql(dirtyWorkSql)} = coverage.projection_identity
    AND (
      ${dirtyWorkSql}.source_partition = coverage.source_partition
      OR ${sourceKeySql} = coverage.source_partition
      OR ${getDirtyWorkSourceWatermarkKeySql(`${dirtyWorkSql}.source_partition`)} = coverage.source_partition
    )
    AND ${dirtyWorkSql}.latest_source_high_water_mark <= coverage.completed_source_high_water_mark
  `
}

const getWatermarkAdvancingCoverages = (coverages: readonly ReviewServingDirtyWorkCoverage[]) => {
  return coverages.filter((coverage) => {
    return coverage.sourcePartition.includes(':')
  })
}

// Rows are matched by id only. DuckDB renumbers rowids when a checkpoint vacuums deleted rows, so a stored rowid
// can point at a different row once completed work has been deleted.
const getDirtyWorkUpdatePredicate = (claims: readonly Pick<ReviewServingDirtyWorkClaim, 'dirtyWorkId'>[]) => {
  const dirtyWorkIds = [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyWorkId
      }),
    ),
  ]

  return `dirty_work_id IN (${dirtyWorkIds.map(getSqlLiteral).join(', ')})`
}

const getDirtyWorkLaneProjectId = (projectId: string | null) => {
  return projectId ?? ''
}

const getDirtyWorkHighWaterOrderSql = (claimStateSql: string) => {
  return `struct_pack(
        latest_source_high_water_mark := ${claimStateSql}.latest_source_high_water_mark,
        updated_at := ${claimStateSql}.updated_at,
        dirty_work_id := ${claimStateSql}.dirty_work_id
      )`
}

type DirtyWorkClaimStateInput = Pick<
  ReviewServingDirtyWorkClaim,
  | 'dirtyRangeEnd'
  | 'dirtyRangeStart'
  | 'dirtyWorkId'
  | 'latestSourceHighWaterMark'
  | 'lifecycleReason'
  | 'projectId'
  | 'projectionComponent'
  | 'projectionIdentity'
  | 'sourcePartition'
  | 'status'
  | 'storageRowId'
>

const getDirtyWorkIdListSql = (dirtyWorkIds: readonly string[]) => {
  return dirtyWorkIds.map(getSqlLiteral).join(', ')
}

const isDirtyWorkClaimStateMaintainable = (
  claim: Pick<DirtyWorkClaimStateInput, 'projectionIdentity' | 'sourcePartition'>,
) => {
  return claim.projectionIdentity.trim().length > 0 && claim.sourcePartition.trim().length > 0
}

const dirtyWorkClaimStateRowColumns = [
  {name: 'dirty_work_id', type: 'VARCHAR'},
  {name: 'storage_row_id', type: 'BIGINT'},
  {name: 'project_id', type: 'VARCHAR'},
  {name: 'projection_component', type: 'VARCHAR'},
  {name: 'projection_identity', type: 'VARCHAR'},
  {name: 'source_partition', type: 'VARCHAR'},
  {name: 'status', type: 'VARCHAR'},
  {name: 'lifecycle_reason', type: 'VARCHAR'},
  {name: 'latest_source_high_water_mark', type: 'BIGINT'},
  {name: 'dirty_range_start', type: 'VARCHAR'},
  {name: 'dirty_range_end', type: 'VARCHAR'},
] as const

// storage_row_id stays NULL: DuckDB renumbers rowids when a checkpoint vacuums deleted rows, so claim state never
// points at dirty work by rowid.
const getDirtyWorkClaimStateRowsSql = (claims: readonly DirtyWorkClaimStateInput[]) => {
  return getReviewServingJsonRowsSql({
    columns: dirtyWorkClaimStateRowColumns,
    rows: claims.map((claim) => {
      return [
        claim.dirtyWorkId,
        null,
        getDirtyWorkLaneProjectId(claim.projectId),
        claim.projectionComponent,
        claim.projectionIdentity,
        claim.sourcePartition,
        claim.status,
        claim.lifecycleReason ?? null,
        claim.latestSourceHighWaterMark,
        claim.dirtyRangeStart,
        claim.dirtyRangeEnd,
      ]
    }),
  })
}

const maintainReviewServingDirtyWorkClaimStates = async (
  claims: readonly DirtyWorkClaimStateInput[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const maintainableClaims = claims.filter(isDirtyWorkClaimStateMaintainable)

  if (maintainableClaims.length === 0) {
    return
  }

  const dirtyWorkIdsSql = getDirtyWorkIdListSql([
    ...new Set(
      maintainableClaims.map((claim) => {
        return claim.dirtyWorkId
      }),
    ),
  ])

  const changedRowsSql = getDirtyWorkClaimStateRowsSql(maintainableClaims)

  await database.run(`
    UPDATE app.review_serving_dirty_work_claim_state existing
    SET
      storage_row_id = NULL,
      project_id = changed.project_id,
      projection_component = changed.projection_component,
      projection_identity = changed.projection_identity,
      source_partition = changed.source_partition,
      status = changed.status,
      lifecycle_reason = changed.lifecycle_reason,
      latest_source_high_water_mark = changed.latest_source_high_water_mark,
      dirty_range_start = changed.dirty_range_start,
      dirty_range_end = changed.dirty_range_end,
      updated_at = current_timestamp
    FROM (
      ${changedRowsSql}
    ) AS changed
    WHERE existing.dirty_work_id = changed.dirty_work_id
      AND existing.dirty_work_id IN (${dirtyWorkIdsSql})
  `)

  await database.run(`
    INSERT INTO app.review_serving_dirty_work_claim_state (
      dirty_work_id,
      storage_row_id,
      project_id,
      projection_component,
      projection_identity,
      source_partition,
      status,
      lifecycle_reason,
      latest_source_high_water_mark,
      dirty_range_start,
      dirty_range_end,
      updated_at
    )
    SELECT
      changed.dirty_work_id,
      changed.storage_row_id,
      changed.project_id,
      changed.projection_component,
      changed.projection_identity,
      changed.source_partition,
      changed.status,
      changed.lifecycle_reason,
      changed.latest_source_high_water_mark,
      changed.dirty_range_start,
      changed.dirty_range_end,
      current_timestamp
    FROM (
      ${changedRowsSql}
    ) AS changed
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work_claim_state existing
      WHERE existing.dirty_work_id = changed.dirty_work_id
        AND existing.dirty_work_id IN (${dirtyWorkIdsSql})
    )
  `)
}

const getDirtyWorkClaimStatePredicate = (claims: readonly Pick<DirtyWorkClaimStateRow, 'dirtyWorkId'>[]) => {
  const dirtyWorkIds = [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyWorkId
      }),
    ),
  ]

  return dirtyWorkIds.length === 0 ? 'FALSE' : `dirty_work_id IN (${getDirtyWorkIdListSql(dirtyWorkIds)})`
}

const getDirtyWorkClaimWatermarkKey = (
  claim: Pick<ReviewServingDirtyWorkClaim, 'dirtyWorkId' | 'latestSourceHighWaterMark'>,
) => {
  return `${claim.dirtyWorkId}@${Math.trunc(Number(claim.latestSourceHighWaterMark))}`
}

const getDirtyWorkClaimWatermarkPredicate = (
  claims: readonly Pick<ReviewServingDirtyWorkClaim, 'dirtyWorkId' | 'latestSourceHighWaterMark'>[],
) => {
  return `dirty_work_id || '@' || CAST(latest_source_high_water_mark AS VARCHAR) IN (${claims
    .map((claim) => {
      return getSqlLiteral(getDirtyWorkClaimWatermarkKey(claim))
    })
    .join(', ')})`
}

export const upsertReviewServingDirtyWork = async (
  input: ReviewServingDirtyWorkInput,
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const dirtyWorkId = getDirtyWorkId(input)
  const skipped = false

  const projectionKey = getProjectionKey({
    projectionComponent: input.projectionComponent,
    projectionIdentity: input.projectionIdentity,
  })

  const updatedRows = await database.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work
    SET
      first_source_high_water_mark = LEAST(
        first_source_high_water_mark,
        ${getSqlLiteral(input.scope.sourceHighWaterMark)}
      ),
      latest_source_high_water_mark = GREATEST(
        latest_source_high_water_mark,
        ${getSqlLiteral(input.scope.sourceHighWaterMark)}
      ),
      latest_delta_id = ${getSqlLiteral(input.latestDeltaId ?? null)},
      projection_component = ${getSqlLiteral(input.projectionComponent)},
      projection_identity = ${getSqlLiteral(input.projectionIdentity)},
      dirty_range_start = CASE
        WHEN dirty_range_start IS NULL THEN ${getSqlLiteral(input.scope.dirtyRangeStart)}
        WHEN ${getSqlLiteral(input.scope.dirtyRangeStart)} IS NULL THEN dirty_range_start
        ELSE LEAST(dirty_range_start, ${getSqlLiteral(input.scope.dirtyRangeStart)})
      END,
      dirty_range_end = CASE
        WHEN dirty_range_end IS NULL THEN ${getSqlLiteral(input.scope.dirtyRangeEnd)}
        WHEN ${getSqlLiteral(input.scope.dirtyRangeEnd)} IS NULL THEN dirty_range_end
        ELSE GREATEST(dirty_range_end, ${getSqlLiteral(input.scope.dirtyRangeEnd)})
      END,
      status = 'pending',
      lifecycle_reason = NULL,
      source_changed_at = current_timestamp,
      updated_at = current_timestamp
    WHERE dirty_work_id = ${getSqlLiteral(dirtyWorkId)}
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (updatedRows.length > 0) {
    await maintainReviewServingDirtyWorkClaimStates(updatedRows.map(getDirtyWorkRecordFromRow), database)

    return {dirtyWorkId, skipped}
  }

  if (!(await reserveReviewServingDirtyWorkId(dirtyWorkId, database))) {
    const existing = await getReviewServingDirtyWork(dirtyWorkId, database)

    if (existing !== null) {
      await maintainReviewServingDirtyWorkClaimStates([existing], database)

      return {dirtyWorkId, skipped}
    }

    // A reservation without its row must not swallow the change: fall through and insert the row.
  }

  await database.run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id,
      project_id,
      scope_kind,
      scope_id,
      article_id,
      projection_key,
      projection_component,
      projection_identity,
      dirty_kind,
      source_partition,
      first_source_high_water_mark,
      latest_source_high_water_mark,
      latest_delta_id,
      dirty_range_start,
      dirty_range_end,
      status,
      lifecycle_reason,
      source_changed_at,
      updated_at
    )
    VALUES (
      ${getSqlLiteral(dirtyWorkId)},
      ${getSqlLiteral(input.scope.projectId)},
      ${getSqlLiteral(input.scope.scopeKind)},
      ${getSqlLiteral(input.scope.scopeId)},
      ${getSqlLiteral(getArticleId(input))},
      ${getSqlLiteral(projectionKey)},
      ${getSqlLiteral(input.projectionComponent)},
      ${getSqlLiteral(input.projectionIdentity)},
      ${getSqlLiteral(input.scope.dirtyKind)},
      ${getSqlLiteral(input.scope.sourcePartition)},
      ${getSqlLiteral(input.scope.sourceHighWaterMark)},
      ${getSqlLiteral(input.scope.sourceHighWaterMark)},
      ${getSqlLiteral(input.latestDeltaId ?? null)},
      ${getSqlLiteral(input.scope.dirtyRangeStart)},
      ${getSqlLiteral(input.scope.dirtyRangeEnd)},
      'pending',
      NULL,
      current_timestamp,
      current_timestamp
    )
  `)

  const inserted = await getReviewServingDirtyWork(dirtyWorkId, database)

  if (inserted !== null) {
    await maintainReviewServingDirtyWorkClaimStates([inserted], database)
  }

  return {dirtyWorkId, skipped}
}

type MergedDirtyWorkInput = {
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string
  firstSourceHighWaterMark: number
  input: ReviewServingDirtyWorkInput
  latestDeltaId: string | null
  latestSourceHighWaterMark: number
}

const getMinNonNull = (left: string | null, right: string | null) => {
  return left === null ? right : right === null ? left : left < right ? left : right
}

const getMaxNonNull = (left: string | null, right: string | null) => {
  return left === null ? right : right === null ? left : left > right ? left : right
}

const getMergedDirtyWorkInput = (
  existing: MergedDirtyWorkInput | undefined,
  dirtyWorkId: string,
  input: ReviewServingDirtyWorkInput,
): MergedDirtyWorkInput => {
  const dirtyRangeStart = input.scope.dirtyRangeStart ?? null
  const dirtyRangeEnd = input.scope.dirtyRangeEnd ?? null

  return existing
    ? {
        ...existing,
        dirtyRangeEnd: getMaxNonNull(existing.dirtyRangeEnd, dirtyRangeEnd),
        dirtyRangeStart: getMinNonNull(existing.dirtyRangeStart, dirtyRangeStart),
        firstSourceHighWaterMark: Math.min(existing.firstSourceHighWaterMark, input.scope.sourceHighWaterMark),
        latestDeltaId: input.latestDeltaId ?? null,
        latestSourceHighWaterMark: Math.max(existing.latestSourceHighWaterMark, input.scope.sourceHighWaterMark),
      }
    : {
        dirtyRangeEnd,
        dirtyRangeStart,
        dirtyWorkId,
        firstSourceHighWaterMark: input.scope.sourceHighWaterMark,
        input,
        latestDeltaId: input.latestDeltaId ?? null,
        latestSourceHighWaterMark: input.scope.sourceHighWaterMark,
      }
}

// Folds repeated inputs for one dirty-work id the same way sequential upserts would: widest
// watermark and range, and the last input's delta id.
const getMergedDirtyWorkInputs = (
  inputs: readonly ReviewServingDirtyWorkInput[],
  dirtyWorkIds: readonly string[],
): MergedDirtyWorkInput[] => {
  const merged = inputs.reduce((state, input, index) => {
    const dirtyWorkId = dirtyWorkIds[index] ?? getDirtyWorkId(input)

    return state.set(dirtyWorkId, getMergedDirtyWorkInput(state.get(dirtyWorkId), dirtyWorkId, input))
  }, new Map<string, MergedDirtyWorkInput>())

  return Array.from(merged.values())
}

const dirtyWorkBatchStageColumns = [
  'input_index',
  'dirty_work_id',
  'project_id',
  'scope_kind',
  'scope_id',
  'article_id',
  'projection_key',
  'projection_component',
  'projection_identity',
  'dirty_kind',
  'source_partition',
  'first_source_high_water_mark',
  'latest_source_high_water_mark',
  'latest_delta_id',
  'dirty_range_start',
  'dirty_range_end',
  'claim_state_maintainable',
] as const

type DirtyWorkBatchStageColumn = (typeof dirtyWorkBatchStageColumns)[number]

const dirtyWorkBatchStageColumnTypes: Record<DirtyWorkBatchStageColumn, 'BIGINT' | 'BOOLEAN' | 'VARCHAR'> = {
  article_id: 'VARCHAR',
  claim_state_maintainable: 'BOOLEAN',
  dirty_kind: 'VARCHAR',
  dirty_range_end: 'VARCHAR',
  dirty_range_start: 'VARCHAR',
  dirty_work_id: 'VARCHAR',
  first_source_high_water_mark: 'BIGINT',
  input_index: 'BIGINT',
  latest_delta_id: 'VARCHAR',
  latest_source_high_water_mark: 'BIGINT',
  project_id: 'VARCHAR',
  projection_component: 'VARCHAR',
  projection_identity: 'VARCHAR',
  projection_key: 'VARCHAR',
  scope_id: 'VARCHAR',
  scope_kind: 'VARCHAR',
  source_partition: 'VARCHAR',
}

const dirtyWorkBatchInsertColumns = dirtyWorkBatchStageColumns.filter((column) => {
  return column !== 'input_index' && column !== 'claim_state_maintainable'
})

const getDirtyWorkBatchStageTableName = () => {
  return `temp_review_serving_dirty_work_batch_${randomUUID().replaceAll('-', '_')}`
}

const getCreateDirtyWorkBatchStageTableSql = (tableName: string) => {
  return `
    CREATE TEMP TABLE ${tableName} (
      ${dirtyWorkBatchStageColumns
        .map((column) => {
          return `${column} ${dirtyWorkBatchStageColumnTypes[column]}`
        })
        .join(',\n      ')}
    )
  `
}

const dirtyWorkBatchStageProjectionColumns = [
  'projection_component',
  'projection_identity',
  'projection_key',
] as const satisfies readonly DirtyWorkBatchStageColumn[]

const dirtyWorkBatchStageScopeColumns = [
  'project_id',
  'scope_kind',
  'scope_id',
  'article_id',
  'dirty_kind',
  'source_partition',
  'first_source_high_water_mark',
  'latest_source_high_water_mark',
  'latest_delta_id',
  'dirty_range_start',
  'dirty_range_end',
] as const satisfies readonly DirtyWorkBatchStageColumn[]

type DirtyWorkBatchStageValues = (string | null)[]

type DirtyWorkBatchStage = {
  projectionIndexes: Map<string, number>
  projections: DirtyWorkBatchStageValues[]
  rows: DirtyWorkBatchStageValues[]
  scopeIndexes: Map<string, number>
  scopes: DirtyWorkBatchStageValues[]
}

const getDirtyWorkBatchStageProjectionValues = (entry: MergedDirtyWorkInput) => {
  return [
    entry.input.projectionComponent,
    entry.input.projectionIdentity,
    getProjectionKey({
      projectionComponent: entry.input.projectionComponent,
      projectionIdentity: entry.input.projectionIdentity,
    }),
  ]
}

const getDirtyWorkBatchStageScopeValues = (entry: MergedDirtyWorkInput) => {
  return [
    entry.input.scope.projectId,
    entry.input.scope.scopeKind,
    entry.input.scope.scopeId,
    getArticleId(entry.input),
    entry.input.scope.dirtyKind,
    entry.input.scope.sourcePartition,
    String(entry.firstSourceHighWaterMark),
    String(entry.latestSourceHighWaterMark),
    entry.latestDeltaId,
    entry.dirtyRangeStart,
    entry.dirtyRangeEnd,
  ]
}

const getDirtyWorkBatchStageIndex = (
  indexes: Map<string, number>,
  entries: DirtyWorkBatchStageValues[],
  values: DirtyWorkBatchStageValues,
) => {
  const key = JSON.stringify(values)
  const existingIndex = indexes.get(key)
  const index = existingIndex ?? indexes.size + 1

  if (existingIndex === undefined) {
    indexes.set(key, index)
    entries.push([String(index), ...values])
  }

  return String(index)
}

const getDirtyWorkBatchStage = (entries: readonly MergedDirtyWorkInput[]) => {
  return entries.reduce<DirtyWorkBatchStage>(
    (stage, entry, inputIndex) => {
      const projectionIndex = getDirtyWorkBatchStageIndex(
        stage.projectionIndexes,
        stage.projections,
        getDirtyWorkBatchStageProjectionValues(entry),
      )
      const scopeIndex = getDirtyWorkBatchStageIndex(
        stage.scopeIndexes,
        stage.scopes,
        getDirtyWorkBatchStageScopeValues(entry),
      )
      const claimStateMaintainable = isDirtyWorkClaimStateMaintainable({
        projectionIdentity: entry.input.projectionIdentity,
        sourcePartition: entry.input.scope.sourcePartition,
      })

      stage.rows.push([
        String(inputIndex),
        entry.dirtyWorkId,
        claimStateMaintainable ? '1' : '0',
        projectionIndex,
        scopeIndex,
      ])

      return stage
    },
    {projectionIndexes: new Map(), projections: [], rows: [], scopeIndexes: new Map(), scopes: []},
  )
}

const getDirtyWorkBatchStageValueSql = (alias: string, column: DirtyWorkBatchStageColumn, position: number) => {
  return dirtyWorkBatchStageColumnTypes[column] === 'VARCHAR'
    ? `${alias}.value[${position}]`
    : `CAST(${alias}.value[${position}] AS ${dirtyWorkBatchStageColumnTypes[column]})`
}

const getDirtyWorkBatchStageValuesSql = (values: readonly DirtyWorkBatchStageValues[]) => {
  return `SELECT unnest(from_json(${getSqlLiteral(JSON.stringify(values))}, '[["VARCHAR"]]')) AS value`
}

const getStageDirtyWorkBatchSql = (tableName: string, entries: readonly MergedDirtyWorkInput[]) => {
  const stage = getDirtyWorkBatchStage(entries)

  return `
    INSERT INTO ${tableName} (
      input_index,
      dirty_work_id,
      claim_state_maintainable,
      ${[...dirtyWorkBatchStageProjectionColumns, ...dirtyWorkBatchStageScopeColumns].join(',\n      ')}
    )
    SELECT
      CAST(staged_row.value[1] AS BIGINT),
      staged_row.value[2],
      staged_row.value[3] = '1',
      ${[
        ...dirtyWorkBatchStageProjectionColumns.map((column, index) => {
          return getDirtyWorkBatchStageValueSql('staged_projection', column, index + 2)
        }),
        ...dirtyWorkBatchStageScopeColumns.map((column, index) => {
          return getDirtyWorkBatchStageValueSql('staged_scope', column, index + 2)
        }),
      ].join(',\n      ')}
    FROM (${getDirtyWorkBatchStageValuesSql(stage.rows)}) staged_row
    INNER JOIN (${getDirtyWorkBatchStageValuesSql(stage.projections)}) staged_projection
      ON staged_projection.value[1] = staged_row.value[4]
    INNER JOIN (${getDirtyWorkBatchStageValuesSql(stage.scopes)}) staged_scope
      ON staged_scope.value[1] = staged_row.value[5]
  `
}

const getReservedDirtyWorkBatchIds = async (tableName: string, database: ReviewServingDirtyWorkTransaction) => {
  const rows = await database.queryJson<{dirtyWorkId: string}>(`
    SELECT lookup.dirty_work_id AS dirtyWorkId
    FROM app.review_serving_dirty_work_id_lookup lookup
    WHERE lookup.dirty_work_id IN (
      SELECT staged.dirty_work_id
      FROM ${tableName} staged
    )
  `)

  return rows.map((row) => {
    return row.dirtyWorkId
  })
}

const updateReservedDirtyWorkBatch = async (
  tableName: string,
  reservedIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (reservedIds.length === 0) {
    return 0
  }

  const reservedIdsSql = getDirtyWorkIdListSql(reservedIds)
  const updatedRows = await database.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work existing
    SET
      first_source_high_water_mark = LEAST(existing.first_source_high_water_mark, changed.first_source_high_water_mark),
      latest_source_high_water_mark = GREATEST(existing.latest_source_high_water_mark, changed.latest_source_high_water_mark),
      latest_delta_id = changed.latest_delta_id,
      projection_component = changed.projection_component,
      projection_identity = changed.projection_identity,
      dirty_range_start = CASE
        WHEN existing.dirty_range_start IS NULL THEN changed.dirty_range_start
        WHEN changed.dirty_range_start IS NULL THEN existing.dirty_range_start
        ELSE LEAST(existing.dirty_range_start, changed.dirty_range_start)
      END,
      dirty_range_end = CASE
        WHEN existing.dirty_range_end IS NULL THEN changed.dirty_range_end
        WHEN changed.dirty_range_end IS NULL THEN existing.dirty_range_end
        ELSE GREATEST(existing.dirty_range_end, changed.dirty_range_end)
      END,
      status = 'pending',
      lifecycle_reason = NULL,
      source_changed_at = current_timestamp,
      updated_at = current_timestamp
    FROM ${tableName} changed
    WHERE existing.dirty_work_id = changed.dirty_work_id
      AND existing.dirty_work_id IN (${reservedIdsSql})
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  await maintainReviewServingDirtyWorkClaimStates(updatedRows.map(getDirtyWorkRecordFromRow), database)

  const updatedIds = new Set(
    updatedRows.map((row) => {
      return row.dirtyWorkId
    }),
  )
  const orphanedIds = reservedIds.filter((dirtyWorkId) => {
    return !updatedIds.has(dirtyWorkId)
  })

  if (updatedIds.size > 0) {
    await database.run(`
      DELETE FROM ${tableName}
      WHERE dirty_work_id IN (${getDirtyWorkIdListSql([...updatedIds])})
    `)
  }

  // A reserved id whose row is missing stays staged, so insertNewDirtyWorkBatch re-creates the row instead of the
  // change being dropped. Any claim state left for it is replaced by the new row's.
  if (orphanedIds.length > 0) {
    await database.run(`
      DELETE FROM app.review_serving_dirty_work_claim_state
      WHERE dirty_work_id IN (${getDirtyWorkIdListSql(orphanedIds)})
    `)
  }

  return updatedIds.size
}

const insertNewDirtyWorkBatch = async (tableName: string, database: ReviewServingDirtyWorkTransaction) => {
  await database.run(`
    INSERT INTO app.review_serving_dirty_work_id_lookup (dirty_work_id)
    SELECT staged.dirty_work_id
    FROM ${tableName} staged
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work_id_lookup lookup
      WHERE lookup.dirty_work_id = staged.dirty_work_id
    )
    ORDER BY staged.input_index
  `)
  await database.run(`
    INSERT INTO app.review_serving_dirty_work (
      ${dirtyWorkBatchInsertColumns.join(',\n      ')},
      status,
      lifecycle_reason,
      source_changed_at,
      updated_at
    )
    SELECT
      ${dirtyWorkBatchInsertColumns.join(',\n      ')},
      'pending',
      NULL,
      current_timestamp,
      current_timestamp
    FROM ${tableName}
    ORDER BY input_index
  `)
  await database.run(`
    INSERT INTO app.review_serving_dirty_work_claim_state (
      dirty_work_id,
      storage_row_id,
      project_id,
      projection_component,
      projection_identity,
      source_partition,
      status,
      lifecycle_reason,
      latest_source_high_water_mark,
      dirty_range_start,
      dirty_range_end,
      updated_at
    )
    SELECT
      staged.dirty_work_id,
      NULL,
      COALESCE(staged.project_id, ''),
      staged.projection_component,
      staged.projection_identity,
      staged.source_partition,
      'pending',
      NULL,
      staged.latest_source_high_water_mark,
      staged.dirty_range_start,
      staged.dirty_range_end,
      current_timestamp
    FROM ${tableName} staged
    WHERE staged.claim_state_maintainable
    ORDER BY staged.input_index
  `)
}

const upsertReviewServingDirtyWorkBatchChunk = async (
  entries: readonly MergedDirtyWorkInput[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const tableName = getDirtyWorkBatchStageTableName()

  await database.run(getCreateDirtyWorkBatchStageTableSql(tableName))
  await database.run(getStageDirtyWorkBatchSql(tableName, entries))

  const reservedIds = await getReservedDirtyWorkBatchIds(tableName, database)
  const updatedCount = await updateReservedDirtyWorkBatch(tableName, reservedIds, database)

  if (updatedCount < entries.length) {
    await insertNewDirtyWorkBatch(tableName, database)
  }

  await database.run(`DROP TABLE IF EXISTS ${tableName}`)
}

export const reviewServingDirtyWorkBatchChunkSize = 4_096

// Set-based equivalent of calling upsertReviewServingDirtyWork for each input in order. A few
// statements per chunk instead of about seven per input keeps judgment imports from holding the
// owner DuckDB queue for tens of seconds.
export const upsertReviewServingDirtyWorkBatch = async (
  inputs: readonly ReviewServingDirtyWorkInput[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const dirtyWorkIds = inputs.map(getDirtyWorkId)
  const merged = getMergedDirtyWorkInputs(inputs, dirtyWorkIds)
  const chunks = Array.from(
    {length: Math.ceil(merged.length / reviewServingDirtyWorkBatchChunkSize)},
    (_value, index) => {
      return merged.slice(
        index * reviewServingDirtyWorkBatchChunkSize,
        (index + 1) * reviewServingDirtyWorkBatchChunkSize,
      )
    },
  )

  await chunks.reduce(async (previous, chunk) => {
    await previous
    await upsertReviewServingDirtyWorkBatchChunk(chunk, database)
  }, Promise.resolve())

  return dirtyWorkIds.map((dirtyWorkId) => {
    return {dirtyWorkId, skipped: false}
  })
}

export const getReviewServingDirtyWork = async (
  dirtyWorkId: string,
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const [row] = await database.queryJson<DirtyWorkRow>(`
    ${getDirtyWorkSelect()}
    WHERE dirty_work_id = ${getSqlLiteral(dirtyWorkId)}
    LIMIT 1
  `)

  return row === undefined ? null : getDirtyWorkRecordFromRow(row)
}

const reconcileUnclaimedDirtyWorkClaimStates = async (
  selectedClaimStateRows: readonly DirtyWorkClaimStateRow[],
  claimedRows: readonly DirtyWorkRow[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const claimedDirtyWorkIds = new Set(
    claimedRows.map((row) => {
      return row.dirtyWorkId
    }),
  )
  const unclaimedClaimStateRows = selectedClaimStateRows.filter((row) => {
    return !claimedDirtyWorkIds.has(row.dirtyWorkId)
  })

  if (unclaimedClaimStateRows.length === 0) {
    return
  }

  const currentRows = await database.queryJson<DirtyWorkRow>(`
    ${getDirtyWorkSelect()}
    WHERE ${getDirtyWorkClaimStatePredicate(unclaimedClaimStateRows)}
  `)
  await maintainReviewServingDirtyWorkClaimStates(currentRows.map(getDirtyWorkRecordFromRow), database)

  const currentDirtyWorkIds = new Set(
    currentRows.map((row) => {
      return row.dirtyWorkId
    }),
  )
  const missingDirtyWorkIds = unclaimedClaimStateRows
    .map((row) => {
      return row.dirtyWorkId
    })
    .filter((dirtyWorkId) => {
      return !currentDirtyWorkIds.has(dirtyWorkId)
    })

  if (missingDirtyWorkIds.length === 0) {
    return
  }

  await database.run(`
    DELETE FROM app.review_serving_dirty_work_claim_state
    WHERE dirty_work_id IN (${missingDirtyWorkIds.map(getSqlLiteral).join(', ')})
  `)
}

const claimStateWindowColumnsSql = `
        state.dirty_work_id AS dirtyWorkId,
        state.storage_row_id AS storageRowId,
        state.project_id AS projectId,
        state.projection_component AS projectionComponent,
        state.projection_identity AS projectionIdentity,
        state.source_partition AS sourcePartition,
        state.status,
        state.latest_source_high_water_mark AS latestSourceHighWaterMark,
        state.dirty_range_start AS dirtyRangeStart,
        state.dirty_range_end AS dirtyRangeEnd,
        state.updated_at AS updatedAt`

type ClaimStateWindowInput = {
  claimNowSql: string
  limit: number
  params: ClaimReviewServingDirtyWorkParams
  projectId: string
}

const getOldestClaimStateWindowSql = (input: ClaimStateWindowInput) => {
  return `
      SELECT${claimStateWindowColumnsSql}
      FROM app.review_serving_dirty_work_claim_state state
      WHERE state.project_id = ${getSqlLiteral(input.projectId)}
        AND ${getEligibleDirtyWorkClaimStatePredicate(input.params, input.claimNowSql, 'state')}
      ORDER BY state.updated_at ASC, state.latest_source_high_water_mark ASC, state.dirty_work_id ASC
      LIMIT ${getLaneWindowLimit(input.limit)}
    `
}

const getNewestClaimStateWindowSql = (input: ClaimStateWindowInput) => {
  return `
      WITH newest_lane AS (
        SELECT lane.projection_identity, lane.source_partition
        FROM app.review_serving_dirty_work_claim_state lane
        WHERE lane.project_id = ${getSqlLiteral(input.projectId)}
          AND ${getEligibleDirtyWorkClaimStatePredicate(input.params, input.claimNowSql, 'lane')}
          AND split_part(lane.source_partition, ':', 1) = ${getSqlLiteral(newestFirstDirtyWorkSourceKey)}
        ORDER BY lane.updated_at DESC, lane.latest_source_high_water_mark DESC, lane.dirty_work_id DESC
        LIMIT 1
      )
      SELECT${claimStateWindowColumnsSql}
      FROM app.review_serving_dirty_work_claim_state state
      INNER JOIN newest_lane
        ON newest_lane.projection_identity = state.projection_identity
        AND newest_lane.source_partition = state.source_partition
      WHERE state.project_id = ${getSqlLiteral(input.projectId)}
        AND ${getEligibleDirtyWorkClaimStatePredicate(input.params, input.claimNowSql, 'state')}
      ORDER BY state.latest_source_high_water_mark DESC, state.updated_at DESC, state.dirty_work_id DESC
      LIMIT ${getLaneWindowLimit(input.limit)}
    `
}

const getOldestClaimStateWindow = async (input: ClaimStateWindowInput, database: ReviewServingDirtyWorkTransaction) => {
  return {
    claimOrder: 'oldest' as const,
    rows: await database.queryJson<DirtyWorkClaimStateRow>(getOldestClaimStateWindowSql(input)),
  }
}

const getClaimStateWindow = async (input: ClaimStateWindowInput, database: ReviewServingDirtyWorkTransaction) => {
  const newestRows =
    input.params.claimOrder === 'newest'
      ? await database.queryJson<DirtyWorkClaimStateRow>(getNewestClaimStateWindowSql(input))
      : []

  return newestRows.length > 0
    ? {claimOrder: 'newest' as const, rows: newestRows}
    : getOldestClaimStateWindow(input, database)
}

export const claimReviewServingDirtyWork = async (
  params: ClaimReviewServingDirtyWorkParams,
  database: ReviewServingDirtyWorkDatabase = getAppDatabaseService() as ReviewServingDirtyWorkDatabase,
) => {
  const limit = getNormalizedLimit(params)
  const claimNowSql = getClaimNowSql(params)
  const eligiblePredicate = getEligibleDirtyWorkPredicate(params, claimNowSql)

  if (limit === 0) {
    return []
  }

  const rows = await database.transaction(async (tx) => {
    const [targetProject] = await tx.queryJson<{targetProjectId: string}>(`
      WITH project_backlog AS (
        SELECT
          backlog.project_id,
          MIN(backlog.updated_at) AS oldest_eligible_at
        FROM app.review_serving_dirty_work_claim_state backlog
        WHERE ${getEligibleDirtyWorkClaimStatePredicate(params, claimNowSql, 'backlog')}
          AND ${getReviewServingDirtyWorkActiveProjectPredicate('backlog.project_id')}
        GROUP BY backlog.project_id
      ),
      project_service AS (
        SELECT
          served.project_id,
          MAX(served.updated_at) AS last_served_at
        FROM app.review_serving_dirty_work_claim_state served
        WHERE ${getServedDirtyWorkClaimStatePredicate(params, claimNowSql, 'served')}
        GROUP BY served.project_id
      )
      SELECT project_backlog.project_id AS targetProjectId
      FROM project_backlog
      LEFT JOIN project_service ON project_service.project_id = project_backlog.project_id
      ORDER BY
        project_service.last_served_at ASC NULLS FIRST,
        project_backlog.oldest_eligible_at ASC,
        project_backlog.project_id ASC
      LIMIT 1
    `)

    if (targetProject === undefined) {
      return []
    }

    const claimStateWindow = await getClaimStateWindow(
      {claimNowSql, limit, params, projectId: targetProject.targetProjectId},
      tx,
    )
    const selectedClaimStateRows = getClaimableDirtyWorkClaimStateRows(params, claimStateWindow, limit)

    if (selectedClaimStateRows.length === 0) {
      return []
    }

    const candidatePredicate = getDirtyWorkClaimStatePredicate(selectedClaimStateRows)
    const claimedRows = await tx.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work
    SET status = 'running', updated_at = current_timestamp
    WHERE ${candidatePredicate}
      AND ${eligiblePredicate}
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)
    await maintainReviewServingDirtyWorkClaimStates(claimedRows.map(getDirtyWorkRecordFromRow), tx)
    await reconcileUnclaimedDirtyWorkClaimStates(selectedClaimStateRows, claimedRows, tx)

    return claimedRows
  })
  const claims = rows.map(getDirtyWorkRecordFromRow)

  return claims.map((claim) => {
    return {...claim, status: 'running' as const}
  })
}

const getUpstreamGateClaimRowsSql = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return getReviewServingJsonRowsSql({
    columns: [
      {name: 'dirty_work_id', type: 'VARCHAR'},
      {name: 'article_id', type: 'VARCHAR'},
      {name: 'source_partition', type: 'VARCHAR'},
      {name: 'latest_source_high_water_mark', type: 'BIGINT'},
    ],
    rows: claims.map((claim) => {
      return [claim.dirtyWorkId, claim.articleId, claim.sourcePartition, claim.latestSourceHighWaterMark]
    }),
  })
}

// Watermarks only order changes within one source partition, so a claim waits for unfinished upstream work of its own
// article and partition that started at or below the claim's watermark. Upstream rows keep their first watermark
// across re-dirtying, which makes the check conservative rather than exact.
export const getReviewServingDirtyWorkClaimIdsAwaitingUpstream = async (
  input: {
    claims: readonly ReviewServingDirtyWorkClaim[]
    projectId: string
    upstreamComponents: readonly ReviewServingProjectionComponent[]
  },
  database: Pick<ReviewServingDirtyWorkTransaction, 'queryJson'>,
) => {
  const articleClaims = input.claims.filter((claim) => {
    return claim.articleId !== null
  })

  if (articleClaims.length === 0 || input.upstreamComponents.length === 0) {
    return new Set<string>()
  }

  const rows = await database.queryJson<{dirtyWorkId: string}>(`
    WITH claimed AS (
      ${getUpstreamGateClaimRowsSql(articleClaims)}
    )
    SELECT DISTINCT claimed.dirty_work_id AS dirtyWorkId
    FROM claimed
    INNER JOIN app.review_serving_dirty_work upstream
      ON upstream.article_id = claimed.article_id
      AND upstream.source_partition = claimed.source_partition
      AND upstream.first_source_high_water_mark <= claimed.latest_source_high_water_mark
    WHERE upstream.project_id = ${getSqlLiteral(input.projectId)}
      AND upstream.projection_component IN (${input.upstreamComponents.map(getSqlLiteral).join(', ')})
      AND upstream.status IN ('pending', 'running', 'failed', 'blocked_by_rebuild')
  `)

  return new Set(
    rows.map((row) => {
      return row.dirtyWorkId
    }),
  )
}

export const releaseReviewServingDirtyWorkClaims = async (
  dirtyWorkIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const uniqueDirtyWorkIds = [...new Set(dirtyWorkIds)]

  if (uniqueDirtyWorkIds.length > 0) {
    const rows = await database.queryJson<DirtyWorkRow>(`
      UPDATE app.review_serving_dirty_work
      SET status = 'pending', lifecycle_reason = 'released', updated_at = current_timestamp
      WHERE dirty_work_id IN (${uniqueDirtyWorkIds.map(getSqlLiteral).join(', ')})
        AND status = 'running'
      RETURNING
        CAST(NULL AS BIGINT) AS storageRowId,
        dirty_work_id AS dirtyWorkId,
        project_id AS projectId,
        scope_kind AS scopeKind,
        scope_id AS scopeId,
        article_id AS articleId,
        projection_key AS projectionKey,
        dirty_kind AS dirtyKind,
        source_partition AS sourcePartition,
        first_source_high_water_mark AS firstSourceHighWaterMark,
        latest_source_high_water_mark AS latestSourceHighWaterMark,
        lifecycle_reason AS lifecycleReason,
        latest_delta_id AS latestDeltaId,
        dirty_range_start AS dirtyRangeStart,
        dirty_range_end AS dirtyRangeEnd,
        projection_component AS projectionComponent,
        projection_identity AS projectionIdentity,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
    `)
    await maintainReviewServingDirtyWorkClaimStates(rows.map(getDirtyWorkRecordFromRow), database)
  }

  return {releasedCount: uniqueDirtyWorkIds.length}
}

export const blockReviewServingDirtyWorkClaimsForRebuild = async (
  dirtyWorkIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const uniqueDirtyWorkIds = [...new Set(dirtyWorkIds)]

  if (uniqueDirtyWorkIds.length > 0) {
    const rows = await database.queryJson<DirtyWorkRow>(`
      UPDATE app.review_serving_dirty_work
      SET status = 'blocked_by_rebuild', lifecycle_reason = 'blocked_by_rebuild', updated_at = current_timestamp
      WHERE dirty_work_id IN (${uniqueDirtyWorkIds.map(getSqlLiteral).join(', ')})
        AND status = 'running'
      RETURNING
        CAST(NULL AS BIGINT) AS storageRowId,
        dirty_work_id AS dirtyWorkId,
        project_id AS projectId,
        scope_kind AS scopeKind,
        scope_id AS scopeId,
        article_id AS articleId,
        projection_key AS projectionKey,
        dirty_kind AS dirtyKind,
        source_partition AS sourcePartition,
        first_source_high_water_mark AS firstSourceHighWaterMark,
        latest_source_high_water_mark AS latestSourceHighWaterMark,
        lifecycle_reason AS lifecycleReason,
        latest_delta_id AS latestDeltaId,
        dirty_range_start AS dirtyRangeStart,
        dirty_range_end AS dirtyRangeEnd,
        projection_component AS projectionComponent,
        projection_identity AS projectionIdentity,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
    `)
    await maintainReviewServingDirtyWorkClaimStates(rows.map(getDirtyWorkRecordFromRow), database)
  }

  return {blockedCount: uniqueDirtyWorkIds.length}
}

export const requeueReviewServingDirtyWorkBlockedByRebuild = async (
  params: RequeueReviewServingDirtyWorkBlockedByRebuildParams,
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const limit = Math.max(0, Math.floor(params.limit))

  if (limit === 0) {
    return {requeuedCount: 0}
  }

  const minBlockedSeconds = Math.max(
    0,
    Math.floor(params.minBlockedSeconds ?? defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds),
  )
  const retryCutoffSql = `${getNowSql(params.now)} - INTERVAL '${minBlockedSeconds} seconds'`
  const candidates = await database.queryJson<Pick<DirtyWorkClaimStateRow, 'dirtyWorkId' | 'storageRowId'>>(`
    SELECT
      blocked_state.dirty_work_id AS dirtyWorkId,
      blocked_state.storage_row_id AS storageRowId
    FROM app.review_serving_dirty_work_claim_state blocked_state
    WHERE blocked_state.status = 'blocked_by_rebuild'
      AND blocked_state.updated_at <= ${retryCutoffSql}
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_request request
        WHERE request.project_id = blocked_state.project_id
          AND (
            request.status IN ('pending_admission', 'admitted', 'running')
            OR (request.status = 'blocked_over_budget' AND request.updated_at > ${retryCutoffSql})
          )
          AND ${getRebuildRequestCoversComponentPredicate('request', 'blocked_state.projection_component')}
      )
    ORDER BY blocked_state.updated_at ASC, blocked_state.dirty_work_id ASC
    LIMIT ${limit}
  `)

  if (candidates.length === 0) {
    return {requeuedCount: 0}
  }

  const rows = await database.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work
    SET status = 'pending', lifecycle_reason = 'released', updated_at = current_timestamp
    WHERE ${getDirtyWorkClaimStatePredicate(candidates)}
      AND status = 'blocked_by_rebuild'
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)
  await maintainReviewServingDirtyWorkClaimStates(rows.map(getDirtyWorkRecordFromRow), database)

  return {requeuedCount: rows.length}
}

export const failReviewServingDirtyWorkClaims = async (
  dirtyWorkIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const uniqueDirtyWorkIds = [...new Set(dirtyWorkIds)]

  if (uniqueDirtyWorkIds.length > 0) {
    const rows = await database.queryJson<DirtyWorkRow>(`
      UPDATE app.review_serving_dirty_work
      SET status = 'failed', lifecycle_reason = 'failed', updated_at = current_timestamp
      WHERE dirty_work_id IN (${uniqueDirtyWorkIds.map(getSqlLiteral).join(', ')})
        AND status = 'running'
      RETURNING
        CAST(NULL AS BIGINT) AS storageRowId,
        dirty_work_id AS dirtyWorkId,
        project_id AS projectId,
        scope_kind AS scopeKind,
        scope_id AS scopeId,
        article_id AS articleId,
        projection_key AS projectionKey,
        dirty_kind AS dirtyKind,
        source_partition AS sourcePartition,
        first_source_high_water_mark AS firstSourceHighWaterMark,
        latest_source_high_water_mark AS latestSourceHighWaterMark,
        lifecycle_reason AS lifecycleReason,
        latest_delta_id AS latestDeltaId,
        dirty_range_start AS dirtyRangeStart,
        dirty_range_end AS dirtyRangeEnd,
        projection_component AS projectionComponent,
        projection_identity AS projectionIdentity,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
    `)
    await maintainReviewServingDirtyWorkClaimStates(rows.map(getDirtyWorkRecordFromRow), database)
  }

  return {failedCount: uniqueDirtyWorkIds.length}
}

const completeReviewServingDirtyWorkClaimsInTransaction = async (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const uniqueClaims = [
    ...new Map(
      claims.map((claim) => {
        return [claim.dirtyWorkId, claim]
      }),
    ).values(),
  ]

  if (uniqueClaims.length > 0) {
    await advanceReviewServingDirtySourceWatermark(uniqueClaims, database)

    await database.run(`
      UPDATE app.review_serving_dirty_work
      SET status = 'completed', lifecycle_reason = 'projected', updated_at = current_timestamp
      WHERE ${getDirtyWorkUpdatePredicate(uniqueClaims)}
        AND status = 'running'
        AND ${getDirtyWorkClaimWatermarkPredicate(uniqueClaims)}
    `)
    const currentRows = await database.queryJson<DirtyWorkRow>(`
      ${getDirtyWorkSelect()}
      WHERE ${getDirtyWorkUpdatePredicate(uniqueClaims)}
    `)
    await maintainReviewServingDirtyWorkClaimStates(currentRows.map(getDirtyWorkRecordFromRow), database)
  }

  return {completedCount: uniqueClaims.length}
}

export const completeReviewServingDirtyWorkClaims = async (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingDirtyWorkTransaction | ReviewServingDirtyWorkDatabase = getAppDatabaseService(),
) => {
  return 'transaction' in database
    ? database.transaction(async (tx) => {
        return completeReviewServingDirtyWorkClaimsInTransaction(claims, tx)
      })
    : completeReviewServingDirtyWorkClaimsInTransaction(claims, database)
}

export const completeReviewServingDirtyWorkCoveredByRebuild = async (
  coverages: readonly ReviewServingDirtyWorkCoverage[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
): Promise<CompleteReviewServingDirtyWorkCoverageResult> => {
  const normalizedCoverages = getNormalizedDirtyWorkCoverages(coverages)

  if (normalizedCoverages.length === 0) {
    return {completedCount: 0}
  }

  const coverageCteSql = getDirtyWorkCoverageCteSql(normalizedCoverages)
  const watermarkAdvancingCoverages = getWatermarkAdvancingCoverages(normalizedCoverages)

  let completedCount = 0

  while (true) {
    const rows = await database.queryJson<DirtyWorkRow>(`
      WITH rebuild_dirty_work_coverage AS (
        ${coverageCteSql}
      ),
      covered_claim_state AS (
        SELECT
          claim_state.dirty_work_id
        FROM app.review_serving_dirty_work_claim_state claim_state
        INNER JOIN rebuild_dirty_work_coverage coverage
          ON ${getDirtyWorkCoverageMatchSql('claim_state')}
        WHERE claim_state.status <> 'completed'
        ORDER BY
          claim_state.updated_at ASC,
          claim_state.latest_source_high_water_mark ASC,
          claim_state.dirty_work_id ASC
        LIMIT ${reviewServingDirtyWorkCoverageCompletionLimit}
      )
      ${getQualifiedDirtyWorkSelect('dirty_work')}
      INNER JOIN covered_claim_state covered
        ON dirty_work.dirty_work_id = covered.dirty_work_id
      WHERE dirty_work.status <> 'completed'
    `)
    const coveredClaims = rows.map(getDirtyWorkRecordFromRow)

    if (coveredClaims.length === 0) {
      break
    }

    await advanceReviewServingDirtySourceWatermarkEntries(
      coveredClaims.map((claim) => {
        return {
          projectId: claim.projectId,
          sourceHighWaterMark: claim.latestSourceHighWaterMark,
          sourcePartition: claim.sourcePartition,
        }
      }),
      database,
    )

    await database.run(`
      UPDATE app.review_serving_dirty_work
      SET status = 'completed', lifecycle_reason = 'covered_by_rebuild', updated_at = current_timestamp
      WHERE ${getDirtyWorkUpdatePredicate(coveredClaims)}
        AND status <> 'completed'
    `)
    await maintainReviewServingDirtyWorkClaimStates(
      coveredClaims.map((claim) => {
        return {...claim, status: 'completed' as const}
      }),
      database,
    )

    completedCount += coveredClaims.length

    if (coveredClaims.length < reviewServingDirtyWorkCoverageCompletionLimit) {
      break
    }
  }

  await advanceReviewServingDirtySourceWatermarkEntries(
    watermarkAdvancingCoverages.map((coverage) => {
      return {
        projectId: coverage.projectId,
        sourceHighWaterMark: coverage.completedSourceHighWaterMark,
        sourcePartition: coverage.sourcePartition,
      }
    }),
    database,
  )

  return {completedCount}
}

// Rows no live claim holds: pending, parked behind a rebuild, or claimed/failed so long ago that the claim is stale
// (its worker restarted; claims pick such rows up again after the same interval).
export const getReviewServingDirtyWorkUnheldPredicate = (dirtyWorkSql: string | null = null) => {
  const column = (name: string) => {
    return dirtyWorkSql === null ? name : `${dirtyWorkSql}.${name}`
  }

  return `(
      ${column('status')} IN ('pending', 'blocked_by_rebuild')
      OR (
        ${column('status')} IN ('running', 'failed')
        AND ${column('updated_at')} <= current_timestamp - INTERVAL '${defaultReviewServingDirtyWorkStaleClaimSeconds} seconds'
      )
    )`
}

// Unheld dirty work whose article a completed rebuild chunk re-read after the change arrived needs no patch: the chunk
// wrote that article from newer source state. It completes and advances the watermark like projected work. Rows that
// changed or were claimed since they were selected are left alone.
export const completeReviewServingDirtyWorkRebuiltByChunks = async (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const uniqueClaims = [
    ...new Map(
      claims.map((claim) => {
        return [claim.dirtyWorkId, claim]
      }),
    ).values(),
  ]

  if (uniqueClaims.length === 0) {
    return {completedCount: 0}
  }

  const completedRows = await database.queryJson<{dirtyWorkId: string}>(`
    UPDATE app.review_serving_dirty_work
    SET status = 'completed', lifecycle_reason = 'covered_by_rebuild', updated_at = current_timestamp
    WHERE ${getDirtyWorkUpdatePredicate(uniqueClaims)}
      AND ${getReviewServingDirtyWorkUnheldPredicate()}
      AND ${getDirtyWorkClaimWatermarkPredicate(uniqueClaims)}
    RETURNING dirty_work_id AS dirtyWorkId
  `)
  const completedDirtyWorkIds = new Set(
    completedRows.map((row) => {
      return row.dirtyWorkId
    }),
  )
  const completedClaims = uniqueClaims.filter((claim) => {
    return completedDirtyWorkIds.has(claim.dirtyWorkId)
  })

  if (completedClaims.length === 0) {
    return {completedCount: 0}
  }

  await advanceReviewServingDirtySourceWatermarkEntries(
    [
      ...completedClaims
        .reduce((entries, claim) => {
          const key = `${claim.projectId ?? ''}\u0000${claim.sourcePartition}`
          const previous = entries.get(key)

          return previous !== undefined && previous.sourceHighWaterMark >= claim.latestSourceHighWaterMark
            ? entries
            : entries.set(key, {
                projectId: claim.projectId,
                sourceHighWaterMark: claim.latestSourceHighWaterMark,
                sourcePartition: claim.sourcePartition,
              })
        }, new Map<string, DirtyWorkSourceWatermarkCompletion>())
        .values(),
    ],
    database,
  )
  await maintainReviewServingDirtyWorkClaimStates(
    completedClaims.map((claim) => {
      return {...claim, lifecycleReason: 'covered_by_rebuild' as const, status: 'completed' as const}
    }),
    database,
  )

  return {completedCount: completedClaims.length}
}

export const getReviewServingDirtyWorkRecordSelectSql = (dirtyWorkSql: string) => {
  return getQualifiedDirtyWorkSelect(dirtyWorkSql)
}

export const getReviewServingDirtyWorkRecordFromRow = (row: unknown) => {
  return getDirtyWorkRecordFromRow(row as DirtyWorkRow)
}

export const completeReviewServingDirtyWorkClaimsAndAdvanceWatermark = async (
  input: {claims: readonly ReviewServingDirtyWorkClaim[]; watermark: ReviewServingProjectorWatermarkAdvanceInput},
  database: ReviewServingDirtyWorkDatabase = getAppDatabaseService() as ReviewServingDirtyWorkDatabase,
) => {
  return database.transaction(async (tx) => {
    await assertReviewServingProjectorWatermarkCanAdvance(tx, input.watermark)
    const completion = await completeReviewServingDirtyWorkClaims(input.claims, tx)

    await advanceReviewServingProjectorWatermark(tx, input.watermark)

    return completion
  })
}

// Completed rows are only history once nothing reads them. Each batch deletes the row, its claim state and its id
// reservation together: a reservation left behind would make the next upsert of that id update nothing and insert
// nothing. The owner runs each transaction alone, so the selected rows cannot change before they are deleted.
const deleteRetainedCompletedReviewServingDirtyWork = async (
  params: {limit: number; now?: Date; retentionSeconds: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  const tableName = `temp_review_serving_dirty_work_retention_${randomUUID().replaceAll('-', '_')}`

  await database.run(`
    CREATE TEMP TABLE ${tableName} AS
    SELECT dirty_work_id
    FROM app.review_serving_dirty_work
    WHERE status = 'completed'
      AND updated_at <= ${getNowSql(params.now)} - INTERVAL '${params.retentionSeconds} seconds'
    LIMIT ${params.limit}
  `)

  const [selection] = await database.queryJson<{selectedCount: number | string}>(`
    SELECT COUNT(*) AS selectedCount
    FROM ${tableName}
  `)
  const selectedCount = Number(selection?.selectedCount ?? 0)

  if (selectedCount > 0) {
    await database.run(`
      DELETE FROM app.review_serving_dirty_work_claim_state
      WHERE dirty_work_id IN (SELECT dirty_work_id FROM ${tableName})
    `)
    await database.run(`
      DELETE FROM app.review_serving_dirty_work_id_lookup
      WHERE dirty_work_id IN (SELECT dirty_work_id FROM ${tableName})
    `)
    await database.run(`
      DELETE FROM app.review_serving_dirty_work
      WHERE dirty_work_id IN (SELECT dirty_work_id FROM ${tableName})
    `)
  }

  await database.run(`DROP TABLE IF EXISTS ${tableName}`)

  return selectedCount
}

const repairReviewServingDirtyWorkLaneColumns = async (
  params: {limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  const rows = await database.queryJson<{storageRowId: number | string}>(`
    SELECT rowid AS storageRowId
    FROM app.review_serving_dirty_work
    WHERE (projection_component IS NULL OR projection_identity IS NULL)
      AND json_extract_string(projection_key, '$.projectionComponent') IS NOT NULL
    ORDER BY rowid ASC
    LIMIT ${params.limit}
  `)
  const rowIds = rows
    .map((row) => {
      return row.storageRowId
    })
    .filter((rowId): rowId is number | string => {
      return rowId !== null && rowId !== undefined && String(rowId).trim().length > 0
    })

  if (rowIds.length === 0) {
    return 0
  }

  const repairedRows = await database.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work
    SET
      projection_component = json_extract_string(projection_key, '$.projectionComponent'),
      projection_identity = json_extract_string(projection_key, '$.projectionIdentity'),
      updated_at = updated_at
    WHERE rowid IN (${rowIds.map(getStorageRowIdSql).join(', ')})
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)
  await maintainReviewServingDirtyWorkClaimStates(repairedRows.map(getDirtyWorkRecordFromRow), database)

  return rowIds.length
}

const repairReviewServingDirtyWorkLaneState = async (
  params: {limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  // Open rows without claim state are invisible to claims. Find them by id: a rowid cursor stops working once a
  // checkpoint renumbers rows after completed work is deleted.
  const rows = await database.queryJson<DirtyWorkRow>(`
    SELECT
      rowid AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.review_serving_dirty_work dirty_work
    WHERE status IN ('pending', 'running', 'failed')
      AND length(trim(COALESCE(projection_identity, ''))) > 0
      AND length(trim(source_partition)) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_serving_dirty_work_claim_state claim_state
        WHERE claim_state.dirty_work_id = dirty_work.dirty_work_id
      )
    ORDER BY dirty_work.updated_at ASC, dirty_work.dirty_work_id ASC
    LIMIT ${params.limit}
  `)

  await maintainReviewServingDirtyWorkClaimStates(rows.map(getDirtyWorkRecordFromRow), database)

  return rows.length
}

const completeReviewServingDirtyWorkOrphans = async (
  params: {limit: number; now?: Date},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  const rows = await database.queryJson<{storageRowId: number | string}>(`
    SELECT rowid AS storageRowId
    FROM app.review_serving_dirty_work orphan
    WHERE orphan.status = 'pending'
      AND orphan.projection_component IS NULL
      AND json_extract_string(orphan.projection_key, '$.projectionComponent') IS NULL
      AND orphan.created_at < ${getNowSql(params.now)} - INTERVAL '${orphanDirtyWorkMinAgeSeconds} seconds'
    ORDER BY orphan.created_at ASC, orphan.dirty_work_id ASC
    LIMIT ${params.limit}
  `)
  const rowIds = rows
    .map((row) => {
      return row.storageRowId
    })
    .filter((rowId): rowId is number | string => {
      return rowId !== null && rowId !== undefined && String(rowId).trim().length > 0
    })

  if (rowIds.length === 0) {
    return 0
  }

  const completedRows = await database.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work
    SET status = 'completed', lifecycle_reason = 'orphan_missing_component', updated_at = current_timestamp
    WHERE rowid IN (${rowIds.map(getStorageRowIdSql).join(', ')})
      AND status = 'pending'
      AND projection_component IS NULL
      AND json_extract_string(projection_key, '$.projectionComponent') IS NULL
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)
  await maintainReviewServingDirtyWorkClaimStates(completedRows.map(getDirtyWorkRecordFromRow), database)

  return completedRows.length
}

const coalesceReviewServingDirtyWorkHighWaterRows = async (
  params: {limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  const candidates = await database.queryJson<Pick<DirtyWorkClaimStateRow, 'dirtyWorkId'>>(`
    WITH project_scope_high_water AS (
      SELECT
        dirty_work.dirty_work_id,
        COALESCE(dirty_work.project_id, '') AS project_id,
        dirty_work.projection_component,
        dirty_work.projection_identity,
        dirty_work.source_partition,
        dirty_work.status,
        dirty_work.latest_source_high_water_mark,
        dirty_work.updated_at
      FROM app.review_serving_dirty_work dirty_work
      WHERE dirty_work.scope_kind = 'project'
        AND dirty_work.article_id IS NULL
        AND dirty_work.status IN ('pending', 'running')
        AND dirty_work.dirty_range_start IS NULL
        AND dirty_work.dirty_range_end IS NULL
        AND dirty_work.projection_component IS NOT NULL
        AND dirty_work.projection_identity IS NOT NULL
    ),
    lane_newest AS (
      SELECT
        newer.project_id,
        newer.projection_component,
        newer.projection_identity,
        newer.source_partition,
        MAX(${getDirtyWorkHighWaterOrderSql('newer')}) AS newest_high_water_order
      FROM project_scope_high_water newer
      GROUP BY newer.project_id, newer.projection_component, newer.projection_identity, newer.source_partition
    )
    SELECT older.dirty_work_id AS dirtyWorkId
    FROM project_scope_high_water older
    JOIN lane_newest
      ON lane_newest.project_id = older.project_id
      AND lane_newest.projection_component = older.projection_component
      AND lane_newest.projection_identity = older.projection_identity
      AND lane_newest.source_partition = older.source_partition
    WHERE older.status = 'pending'
      AND ${getDirtyWorkHighWaterOrderSql('older')} < lane_newest.newest_high_water_order
    ORDER BY older.updated_at ASC, older.latest_source_high_water_mark ASC, older.dirty_work_id ASC
    LIMIT ${params.limit}
  `)

  if (candidates.length === 0) {
    return 0
  }

  const coalescedRows = await database.queryJson<DirtyWorkRow>(`
    UPDATE app.review_serving_dirty_work
    SET status = 'completed', lifecycle_reason = 'superseded_by_high_water', updated_at = current_timestamp
    WHERE dirty_work_id IN (${candidates
      .map((candidate) => {
        return getSqlLiteral(candidate.dirtyWorkId)
      })
      .join(', ')})
      AND status = 'pending'
    RETURNING
      CAST(NULL AS BIGINT) AS storageRowId,
      dirty_work_id AS dirtyWorkId,
      project_id AS projectId,
      scope_kind AS scopeKind,
      scope_id AS scopeId,
      article_id AS articleId,
      projection_key AS projectionKey,
      dirty_kind AS dirtyKind,
      source_partition AS sourcePartition,
      first_source_high_water_mark AS firstSourceHighWaterMark,
      latest_source_high_water_mark AS latestSourceHighWaterMark,
      lifecycle_reason AS lifecycleReason,
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  await maintainReviewServingDirtyWorkClaimStates(coalescedRows.map(getDirtyWorkRecordFromRow), database)

  return coalescedRows.length
}

export const cleanupReviewServingDirtyWorkRetention = async (
  params: CleanupReviewServingDirtyWorkRetentionParams = {},
  database: ReviewServingDirtyWorkDatabase = getAppDatabaseService() as ReviewServingDirtyWorkDatabase,
): Promise<CleanupReviewServingDirtyWorkRetentionResult> => {
  const coalesceDirtyWorkLimit = getNormalizedCleanupLimit(params.coalesceDirtyWorkLimit, defaultCoalesceDirtyWorkLimit)
  const dirtyWorkDeleteLimit = getNormalizedCleanupLimit(
    params.dirtyWorkDeleteLimit,
    defaultCompletedDirtyWorkDeleteLimit,
  )
  const completedRetentionSeconds = getNormalizedCleanupLimit(
    params.completedRetentionSeconds,
    defaultCompletedDirtyWorkRetentionSeconds,
  )
  // Lane column repair backfills projection_component/projection_identity from projection_key for
  // legacy rows. It must run by default (the worker calls cleanup with {}), bounded per cycle like
  // lane state repair; a 0 default meant production rows were never repaired.
  const laneRepairLimit = getNormalizedCleanupLimit(params.laneRepairLimit, defaultLaneRepairLimit)
  const laneStateRepairLimit = getNormalizedCleanupLimit(params.laneStateRepairLimit, defaultLaneStateRepairLimit)
  const blockedByRebuildRequeueLimit = getNormalizedCleanupLimit(
    params.blockedByRebuildRequeueLimit,
    defaultBlockedByRebuildRequeueLimit,
  )
  const orphanCompletionLimit = getNormalizedCleanupLimit(params.orphanCompletionLimit, defaultOrphanCompletionLimit)

  return database.transaction(async (tx) => {
    const repairedLaneColumnCount = await repairReviewServingDirtyWorkLaneColumns({limit: laneRepairLimit}, tx)
    const completedOrphanDirtyWorkCount = await completeReviewServingDirtyWorkOrphans(
      {limit: orphanCompletionLimit, now: params.now},
      tx,
    )
    const repairedLaneStateCount = await repairReviewServingDirtyWorkLaneState({limit: laneStateRepairLimit}, tx)
    const {requeuedCount: requeuedBlockedByRebuildCount} = await requeueReviewServingDirtyWorkBlockedByRebuild(
      {limit: blockedByRebuildRequeueLimit, now: params.now},
      tx,
    )
    const coalescedDirtyWorkCount = await coalesceReviewServingDirtyWorkHighWaterRows(
      {limit: coalesceDirtyWorkLimit},
      tx,
    )
    const deletedDirtyWorkCount = await deleteRetainedCompletedReviewServingDirtyWork(
      {limit: dirtyWorkDeleteLimit, now: params.now, retentionSeconds: completedRetentionSeconds},
      tx,
    )

    return {
      coalescedDirtyWorkCount,
      completedOrphanDirtyWorkCount,
      deletedDirtyWorkCount,
      repairedLaneColumnCount,
      repairedLaneStateCount,
      requeuedBlockedByRebuildCount,
    }
  })
}

import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  advanceReviewServingProjectorWatermark,
  assertReviewServingProjectorWatermarkCanAdvance,
  type ReviewServingProjectorWatermarkAdvanceInput,
} from './reviewServingDeltaReconciliation.ts'
import {getReviewServingDirtyWorkScopeKey, type ReviewServingDirtyWorkScope} from './reviewServingProjectorDomain.ts'

export type ReviewServingDirtyWorkStatus = 'completed' | 'failed' | 'pending' | 'running'

export type ReviewServingDirtyWorkLifecycleReason =
  | 'covered_by_rebuild'
  | 'failed'
  | 'projected'
  | 'released'
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

export type ClaimReviewServingDirtyWorkParams = {
  limit: number
  maxWakeCount?: number
  now?: Date
  projectionComponent: ReviewServingProjectionComponent
  staleRunningClaimSeconds?: number
}

export const defaultReviewServingDirtyWorkStaleClaimSeconds = 15 * 60
const reviewServingDirtyWorkLaneWindowLimit = 2_048
const reviewServingDirtyWorkCoverageCompletionLimit = 2_048
const reviewServingDirtyWorkClaimStateCursorByDatabase = new WeakMap<
  ReviewServingDirtyWorkDatabase,
  Map<ReviewServingProjectionComponent, number>
>()

export type CompactReviewServingDirtyWorkAcknowledgementsParams = {
  completedSourceHighWaterMark: number
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  sourcePartition: string
}

export type CleanupReviewServingDirtyWorkRetentionParams = {
  acknowledgementDeleteLimit?: number
  coalesceDirtyWorkLimit?: number
  dirtyWorkDeleteLimit?: number
  laneCompactionLimit?: number
  laneRepairLimit?: number
  laneStateRepairLimit?: number
}

export type CleanupReviewServingDirtyWorkRetentionCompaction = CompactReviewServingDirtyWorkAcknowledgementsParams & {
  dirtyAckId: string
}

export type CleanupReviewServingDirtyWorkRetentionResult = {
  coalescedDirtyWorkCount?: number
  compactedAcknowledgements: CleanupReviewServingDirtyWorkRetentionCompaction[]
  compactedLaneCount: number
  deletedAcknowledgementCount: number
  deletedDirtyWorkCount: number
  repairedLaneColumnCount?: number
  repairedLaneStateCount?: number
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

const getDirtyWorkId = (input: ReviewServingDirtyWorkInput) => {
  return `dirtyWork:${getReviewServingHash('review-serving-dirty-work', {
    projectionKey: getProjectionKey({
      projectionComponent: input.projectionComponent,
      projectionIdentity: input.projectionIdentity,
    }),
    scopeKey: getReviewServingDirtyWorkScopeKey(input.scope),
  }).slice(0, 32)}`
}

const getDirtyAckId = (claim: ReviewServingDirtyWorkClaim) => {
  return `dirtyAck:${getReviewServingHash('review-serving-dirty-work-ack', {
    dirtyWorkId: claim.dirtyWorkId,
    projectionComponent: claim.projectionComponent,
    projectionIdentity: claim.projectionIdentity,
    sourcePartition: claim.sourcePartition,
    sourceHighWaterMark: claim.latestSourceHighWaterMark,
  }).slice(0, 32)}`
}

const getDirtyAckHighWaterId = (input: CompactReviewServingDirtyWorkAcknowledgementsParams) => {
  return `dirtyAck:${getReviewServingHash('review-serving-dirty-work-ack-high-water', {
    completedSourceHighWaterMark: input.completedSourceHighWaterMark,
    projectionComponent: input.projectionComponent,
    projectionIdentity: input.projectionIdentity,
    sourcePartition: input.sourcePartition,
  }).slice(0, 32)}`
}

const getNormalizedLimit = (params: {limit: number; maxWakeCount?: number}) => {
  const limit = Math.max(0, Math.floor(params.limit))
  const maxWakeCount = params.maxWakeCount === undefined ? limit : Math.max(0, Math.floor(params.maxWakeCount))

  return Math.min(limit, maxWakeCount)
}

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

const getClaimNowSql = (params: ClaimReviewServingDirtyWorkParams) => {
  return params.now === undefined ? 'current_timestamp' : `TIMESTAMPTZ ${getSqlLiteral(params.now.toISOString())}`
}

const getDirtyWorkClaimStateCursorMap = (database: ReviewServingDirtyWorkDatabase) => {
  const existing = reviewServingDirtyWorkClaimStateCursorByDatabase.get(database)

  if (existing !== undefined) {
    return existing
  }

  const cursorByComponent = new Map<ReviewServingProjectionComponent, number>()
  reviewServingDirtyWorkClaimStateCursorByDatabase.set(database, cursorByComponent)

  return cursorByComponent
}

const getClaimNowMs = (params: ClaimReviewServingDirtyWorkParams) => {
  return (params.now ?? new Date()).getTime()
}

const getDirtyWorkClaimStateUpdatedAtMs = (row: DirtyWorkClaimStateRow) => {
  const value = getDateValue(row.updatedAt)

  return value === null ? 0 : value.getTime()
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

const getClaimableDirtyWorkClaimStateRows = (
  params: ClaimReviewServingDirtyWorkParams,
  claimStateRows: readonly DirtyWorkClaimStateRow[],
  limit: number,
) => {
  const eligibleRows = claimStateRows.filter((row) => {
    return (
      row.projectionComponent === params.projectionComponent
      && (row.status === 'pending' || row.status === 'running' || row.status === 'failed')
      && isDirtyWorkClaimStateEligible(params, row)
    )
  })
  const [oldest] = [...eligibleRows].sort(compareDirtyWorkClaimStateRows)

  if (oldest === undefined) {
    return []
  }

  const staleCutoffMs = getClaimNowMs(params) - getStaleRunningClaimSeconds(params) * 1000

  return eligibleRows
    .filter((candidate) => {
      return (
        candidate.projectId === oldest.projectId
        && candidate.projectionComponent === oldest.projectionComponent
        && candidate.projectionIdentity === oldest.projectionIdentity
        && candidate.sourcePartition === oldest.sourcePartition
        && !claimStateRows.some((blocker) => {
          return (
            blocker.projectId === candidate.projectId
            && blocker.projectionComponent === candidate.projectionComponent
            && blocker.projectionIdentity === candidate.projectionIdentity
            && blocker.sourcePartition === candidate.sourcePartition
            && (blocker.status === 'running' || blocker.status === 'failed')
            && getDirtyWorkClaimStateUpdatedAtMs(blocker) > staleCutoffMs
            && Number(blocker.latestSourceHighWaterMark) < Number(candidate.latestSourceHighWaterMark)
          )
        })
      )
    })
    .sort(compareDirtyWorkClaimStateRows)
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

const reserveReviewServingDirtyAckId = async (dirtyAckId: string, database: ReviewServingDirtyWorkTransaction) => {
  const rows = await database.queryJson<{dirtyAckId: string}>(`
    SELECT dirty_ack_id AS dirtyAckId
    FROM app.review_serving_dirty_work_ack_id_lookup
    WHERE dirty_ack_id = ${getSqlLiteral(dirtyAckId)}
    LIMIT 1
  `)

  if (rows.length > 0) {
    return false
  }

  await database.run(`
    INSERT INTO app.review_serving_dirty_work_ack_id_lookup (dirty_ack_id)
    VALUES (${getSqlLiteral(dirtyAckId)})
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

const acknowledgeReviewServingDirtyWorkClaim = async (
  claim: ReviewServingDirtyWorkClaim,
  database: ReviewServingDirtyWorkTransaction,
) => {
  const dirtyAckId = getDirtyAckId(claim)

  if (!(await reserveReviewServingDirtyAckId(dirtyAckId, database))) {
    return
  }

  await database.run(`
    INSERT INTO app.review_serving_dirty_work_ack (
      dirty_ack_id,
      dirty_work_id,
      projection_component,
      projection_identity,
      source_partition,
      completed_source_high_water_mark,
      dirty_range_start,
      dirty_range_end,
      status,
      completed_at
    )
    VALUES (
      ${getSqlLiteral(dirtyAckId)},
      ${getSqlLiteral(claim.dirtyWorkId)},
      ${getSqlLiteral(claim.projectionComponent)},
      ${getSqlLiteral(claim.projectionIdentity)},
      ${getSqlLiteral(claim.sourcePartition)},
      ${getSqlLiteral(claim.latestSourceHighWaterMark)},
      ${getSqlLiteral(claim.dirtyRangeStart)},
      ${getSqlLiteral(claim.dirtyRangeEnd)},
      'completed',
      current_timestamp
    )
  `)
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
    WHEN 'article' THEN 'reviewChange'
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

const getHighWaterAckCoverages = (coverages: readonly ReviewServingDirtyWorkCoverage[]) => {
  return coverages.filter((coverage) => {
    return coverage.sourcePartition.includes(':')
  })
}

const getDirtyWorkUpdatePredicate = (
  claims: readonly Pick<ReviewServingDirtyWorkClaim, 'dirtyWorkId' | 'storageRowId'>[],
) => {
  const dirtyWorkIds = [
    ...new Set(
      claims.map((claim) => {
        return claim.dirtyWorkId
      }),
    ),
  ]
  const rowIds = [
    ...new Set(
      claims
        .map((claim) => {
          return claim.storageRowId
        })
        .filter((rowId): rowId is number | string => {
          return rowId !== null && rowId !== undefined && String(rowId).trim().length > 0
        }),
    ),
  ]

  if (rowIds.length > 0) {
    return `(
      rowid IN (${rowIds
        .map((rowId) => {
          return getStorageRowIdSql(rowId)
        })
        .join(', ')})
      OR dirty_work_id IN (${dirtyWorkIds.map(getSqlLiteral).join(', ')})
    )`
  }

  return `dirty_work_id IN (${dirtyWorkIds.map(getSqlLiteral).join(', ')})`
}

const getDirtyWorkLaneProjectId = (projectId: string | null) => {
  return projectId ?? ''
}

const getDirtyWorkClaimStateValuesSql = (
  claims: readonly Pick<
    ReviewServingDirtyWorkClaim,
    | 'dirtyRangeEnd'
    | 'dirtyRangeStart'
    | 'dirtyWorkId'
    | 'latestSourceHighWaterMark'
    | 'projectId'
    | 'projectionComponent'
    | 'projectionIdentity'
    | 'sourcePartition'
    | 'status'
    | 'storageRowId'
  >[],
) => {
  return claims
    .filter((claim) => {
      return claim.projectionIdentity.trim().length > 0 && claim.sourcePartition.trim().length > 0
    })
    .map((claim) => {
      return `(
        ${getSqlLiteral(claim.dirtyWorkId)},
        ${
          claim.storageRowId === null || claim.storageRowId === undefined
            ? 'NULL'
            : getStorageRowIdSql(claim.storageRowId)
        },
        ${getSqlLiteral(getDirtyWorkLaneProjectId(claim.projectId))},
        ${getSqlLiteral(claim.projectionComponent)},
        ${getSqlLiteral(claim.projectionIdentity)},
        ${getSqlLiteral(claim.sourcePartition)},
        ${getSqlLiteral(claim.status)},
        ${getSqlLiteral(claim.latestSourceHighWaterMark)},
        ${getSqlLiteral(claim.dirtyRangeStart)},
        ${getSqlLiteral(claim.dirtyRangeEnd)}
      )`
    })
    .join(',\n      ')
}

const maintainReviewServingDirtyWorkClaimStates = async (
  claims: readonly Pick<
    ReviewServingDirtyWorkClaim,
    | 'dirtyRangeEnd'
    | 'dirtyRangeStart'
    | 'dirtyWorkId'
    | 'latestSourceHighWaterMark'
    | 'projectId'
    | 'projectionComponent'
    | 'projectionIdentity'
    | 'sourcePartition'
    | 'status'
    | 'storageRowId'
  >[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const valuesSql = getDirtyWorkClaimStateValuesSql(claims)

  if (valuesSql.length === 0) {
    return
  }

  const changedRowsSql = `
    SELECT
      dirty_work_id,
      storage_row_id,
      project_id,
      projection_component,
      projection_identity,
      source_partition,
      status,
      latest_source_high_water_mark,
      dirty_range_start,
      dirty_range_end
    FROM (
      VALUES
      ${valuesSql}
    ) AS changed(
      dirty_work_id,
      storage_row_id,
      project_id,
      projection_component,
      projection_identity,
      source_partition,
      status,
      latest_source_high_water_mark,
      dirty_range_start,
      dirty_range_end
    )
  `

  await database.run(`
    UPDATE app.review_serving_dirty_work_claim_state existing
    SET
      storage_row_id = COALESCE(changed.storage_row_id, existing.storage_row_id),
      project_id = changed.project_id,
      projection_component = changed.projection_component,
      projection_identity = changed.projection_identity,
      source_partition = changed.source_partition,
      status = changed.status,
      latest_source_high_water_mark = changed.latest_source_high_water_mark,
      dirty_range_start = changed.dirty_range_start,
      dirty_range_end = changed.dirty_range_end,
      updated_at = current_timestamp
    FROM (
      ${changedRowsSql}
    ) AS changed
    WHERE existing.dirty_work_id = changed.dirty_work_id
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
    )
  `)
}

const getDirtyWorkClaimStatePredicate = (
  claims: readonly Pick<DirtyWorkClaimStateRow, 'dirtyWorkId' | 'storageRowId'>[],
) => {
  const predicates = claims.map((claim) => {
    return claim.storageRowId === null || claim.storageRowId === undefined
      ? `dirty_work_id = ${getSqlLiteral(claim.dirtyWorkId)}`
      : `(
          (rowid = ${getStorageRowIdSql(claim.storageRowId)} AND dirty_work_id = ${getSqlLiteral(claim.dirtyWorkId)})
          OR dirty_work_id = ${getSqlLiteral(claim.dirtyWorkId)}
        )`
  })

  return predicates.length === 0 ? 'FALSE' : `(${predicates.join(' OR ')})`
}

const isClaimCoveredByHighWaterAckCoverage = (
  claim: ReviewServingDirtyWorkClaim,
  coverages: readonly ReviewServingDirtyWorkCoverage[],
) => {
  return coverages.some((coverage) => {
    return (
      claim.projectId === coverage.projectId
      && claim.projectionComponent === coverage.projectionComponent
      && claim.projectionIdentity === coverage.projectionIdentity
      && claim.sourcePartition === coverage.sourcePartition
      && claim.latestSourceHighWaterMark <= coverage.completedSourceHighWaterMark
    )
  })
}

const insertReviewServingDirtyWorkCoverageAcknowledgements = async (
  coverages: readonly ReviewServingDirtyWorkCoverage[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (coverages.length === 0) {
    return
  }

  const reservedCoverages: Array<ReviewServingDirtyWorkCoverage & {dirtyAckId: string}> = []

  for (const coverage of coverages) {
    const dirtyAckId = getDirtyAckHighWaterId({
      completedSourceHighWaterMark: coverage.completedSourceHighWaterMark,
      projectionComponent: coverage.projectionComponent,
      projectionIdentity: coverage.projectionIdentity,
      sourcePartition: coverage.sourcePartition,
    })

    if (await reserveReviewServingDirtyAckId(dirtyAckId, database)) {
      reservedCoverages.push({...coverage, dirtyAckId})
    }
  }

  if (reservedCoverages.length === 0) {
    return
  }

  const valuesSql = reservedCoverages
    .map((coverage) => {
      return `(
        ${getSqlLiteral(coverage.dirtyAckId)},
        NULL,
        ${getSqlLiteral(coverage.projectionComponent)},
        ${getSqlLiteral(coverage.projectionIdentity)},
        ${getSqlLiteral(coverage.sourcePartition)},
        ${coverage.completedSourceHighWaterMark},
        NULL,
        NULL,
        'completed',
        current_timestamp
      )`
    })
    .join(',\n      ')

  await database.run(`
    INSERT INTO app.review_serving_dirty_work_ack (
      dirty_ack_id,
      dirty_work_id,
      projection_component,
      projection_identity,
      source_partition,
      completed_source_high_water_mark,
      dirty_range_start,
      dirty_range_end,
      status,
      completed_at
    )
    VALUES
      ${valuesSql}
  `)
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
    }

    return {dirtyWorkId, skipped}
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
      current_timestamp
    )
  `)

  const inserted = await getReviewServingDirtyWork(dirtyWorkId, database)

  if (inserted !== null) {
    await maintainReviewServingDirtyWorkClaimStates([inserted], database)
  }

  return {dirtyWorkId, skipped}
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

  const claimStateCursorByComponent = getDirtyWorkClaimStateCursorMap(database)
  const rows = await database.transaction(async (tx) => {
    const cursor = claimStateCursorByComponent.get(params.projectionComponent) ?? -1
    let claimStateRows = await tx.queryJson<DirtyWorkClaimStateRow>(`
      SELECT
        state.rowid AS claimStateRowId,
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
        state.updated_at AS updatedAt
      FROM app.review_serving_dirty_work_claim_state state
      WHERE state.rowid > ${cursor}
      LIMIT ${reviewServingDirtyWorkLaneWindowLimit}
    `)

    if (claimStateRows.length === 0 && cursor >= 0) {
      claimStateRows = await tx.queryJson<DirtyWorkClaimStateRow>(`
        SELECT
          state.rowid AS claimStateRowId,
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
          state.updated_at AS updatedAt
        FROM app.review_serving_dirty_work_claim_state state
        WHERE state.rowid >= 0
        LIMIT ${reviewServingDirtyWorkLaneWindowLimit}
      `)
    }

    const maxClaimStateRowId = Math.max(
      cursor,
      ...claimStateRows.map((row) => {
        return Number(row.claimStateRowId ?? -1)
      }),
    )

    if (Number.isFinite(maxClaimStateRowId)) {
      claimStateCursorByComponent.set(params.projectionComponent, maxClaimStateRowId)
    }

    claimStateRows = getClaimableDirtyWorkClaimStateRows(params, claimStateRows, limit)

    if (claimStateRows.length === 0) {
      return []
    }

    const candidatePredicate = getDirtyWorkClaimStatePredicate(claimStateRows)
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

    return claimedRows
  })
  const claims = rows.map(getDirtyWorkRecordFromRow)

  return claims.map((claim) => {
    return {...claim, status: 'running' as const}
  })
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

export const completeReviewServingDirtyWorkClaims = async (
  claims: readonly ReviewServingDirtyWorkClaim[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const uniqueClaims = [
    ...new Map(
      claims.map((claim) => {
        return [claim.dirtyWorkId, claim]
      }),
    ).values(),
  ]

  await uniqueClaims.reduce<Promise<void>>((previousCompletion, claim) => {
    return previousCompletion.then(async () => {
      await acknowledgeReviewServingDirtyWorkClaim(claim, database)
    })
  }, Promise.resolve())

  if (uniqueClaims.length > 0) {
    await advanceReviewServingDirtySourceWatermark(uniqueClaims, database)

    await database.run(`
      UPDATE app.review_serving_dirty_work
      SET status = 'completed', lifecycle_reason = 'projected', updated_at = current_timestamp
      WHERE ${getDirtyWorkUpdatePredicate(uniqueClaims)}
        AND status = 'running'
    `)
    await maintainReviewServingDirtyWorkClaimStates(
      uniqueClaims.map((claim) => {
        return {...claim, status: 'completed' as const}
      }),
      database,
    )
  }

  return {completedCount: uniqueClaims.length}
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
  const highWaterAckCoverages = getHighWaterAckCoverages(normalizedCoverages)

  let completedCount = 0

  await insertReviewServingDirtyWorkCoverageAcknowledgements(highWaterAckCoverages, database)

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

    const pointAckClaims = coveredClaims.filter((claim) => {
      return !isClaimCoveredByHighWaterAckCoverage(claim, highWaterAckCoverages)
    })

    await pointAckClaims.reduce<Promise<void>>((previousCompletion, claim) => {
      return previousCompletion.then(async () => {
        await acknowledgeReviewServingDirtyWorkClaim(claim, database)
      })
    }, Promise.resolve())

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
    highWaterAckCoverages.map((coverage) => {
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

export const compactReviewServingDirtyWorkAcknowledgements = async (
  input: CompactReviewServingDirtyWorkAcknowledgementsParams,
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const dirtyAckId = getDirtyAckHighWaterId(input)

  if (await reserveReviewServingDirtyAckId(dirtyAckId, database)) {
    await database.run(`
      INSERT INTO app.review_serving_dirty_work_ack (
        dirty_ack_id,
        dirty_work_id,
        projection_component,
        projection_identity,
        source_partition,
        completed_source_high_water_mark,
        dirty_range_start,
        dirty_range_end,
        status,
        completed_at
      )
      VALUES (
        ${getSqlLiteral(dirtyAckId)},
        NULL,
        ${getSqlLiteral(input.projectionComponent)},
        ${getSqlLiteral(input.projectionIdentity)},
        ${getSqlLiteral(input.sourcePartition)},
        ${input.completedSourceHighWaterMark},
        NULL,
        NULL,
        'completed',
        current_timestamp
      )
    `)
  }

  const compactedDirtyAckIds = await database.queryJson<{dirtyAckId: string}>(`
    SELECT dirty_ack_id AS dirtyAckId
    FROM app.review_serving_dirty_work_ack
    WHERE dirty_ack_id <> ${getSqlLiteral(dirtyAckId)}
      AND dirty_work_id IS NOT NULL
      AND projection_component = ${getSqlLiteral(input.projectionComponent)}
      AND projection_identity = ${getSqlLiteral(input.projectionIdentity)}
      AND source_partition = ${getSqlLiteral(input.sourcePartition)}
      AND status = 'completed'
      AND completed_source_high_water_mark <= ${input.completedSourceHighWaterMark}
  `)

  await deleteReviewServingDirtyWorkAcknowledgementsByIds(
    compactedDirtyAckIds.map((row) => {
      return row.dirtyAckId
    }),
    database,
  )

  return {compactedThroughHighWaterMark: input.completedSourceHighWaterMark, dirtyAckId}
}

const getCompletedDirtyWorkCoveredByAckPredicate = (dirtyWorkSql: string) => {
  const projectionComponentSql = getProjectionComponentSql(dirtyWorkSql)
  const projectionIdentitySql = getProjectionIdentitySql(dirtyWorkSql)

  return `EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work_ack ack
      WHERE ack.projection_component = ${projectionComponentSql}
        AND ack.projection_identity = ${projectionIdentitySql}
        AND ack.source_partition = ${dirtyWorkSql}.source_partition
        AND ack.status = 'completed'
        AND ack.completed_source_high_water_mark >= ${dirtyWorkSql}.latest_source_high_water_mark
        AND (
          ack.dirty_work_id = ${dirtyWorkSql}.dirty_work_id
          OR (
            ack.dirty_work_id IS NULL
            AND (
              (ack.dirty_range_start IS NULL AND ack.dirty_range_end IS NULL)
              OR (
                ${dirtyWorkSql}.dirty_range_start IS NOT NULL
                AND ${dirtyWorkSql}.dirty_range_end IS NOT NULL
                AND ack.dirty_range_start <= ${dirtyWorkSql}.dirty_range_start
                AND ack.dirty_range_end >= ${dirtyWorkSql}.dirty_range_end
              )
            )
          )
        )
    )`
}

const getDirtyWorkSourceWatermarkAdvancedPredicate = (dirtyWorkSql: string) => {
  return `${dirtyWorkSql}.project_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM app.review_serving_project_dirty_source_watermark watermark
      WHERE watermark.project_id = ${dirtyWorkSql}.project_id
        AND watermark.source_partition = ${dirtyWorkSql}.source_partition
        AND watermark.source_high_water_mark >= ${dirtyWorkSql}.latest_source_high_water_mark
    )`
}

const getNoLowerRetentionBlockerPredicate = (dirtyWorkSql: string, highWaterMarkSql: string) => {
  return `NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work blocker
      WHERE ${getProjectionComponentSql('blocker')} = ${getProjectionComponentSql(dirtyWorkSql)}
        AND ${getProjectionIdentitySql('blocker')} = ${getProjectionIdentitySql(dirtyWorkSql)}
        AND blocker.source_partition = ${dirtyWorkSql}.source_partition
        AND blocker.status <> 'completed'
        AND blocker.latest_source_high_water_mark <= ${highWaterMarkSql}
    )`
}

const getReviewServingDirtyWorkRetentionLanes = async (
  params: {limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return []
  }

  return database.queryJson<{
    completedSourceHighWaterMark: number
    projectionComponent: ReviewServingProjectionComponent
    projectionIdentity: string
    sourcePartition: string
  }>(`
    WITH retention_ready_dirty_work AS (
      SELECT
        ${getProjectionComponentSql('dirty_work')} AS projectionComponent,
        ${getProjectionIdentitySql('dirty_work')} AS projectionIdentity,
        dirty_work.source_partition AS sourcePartition,
        MAX(dirty_work.latest_source_high_water_mark) AS completedSourceHighWaterMark
      FROM app.review_serving_dirty_work dirty_work
      WHERE dirty_work.status = 'completed'
        AND ${getProjectionComponentSql('dirty_work')} IS NOT NULL
        AND ${getProjectionIdentitySql('dirty_work')} IS NOT NULL
        AND ${getDirtyWorkSourceWatermarkAdvancedPredicate('dirty_work')}
        AND ${getCompletedDirtyWorkCoveredByAckPredicate('dirty_work')}
        AND ${getNoLowerRetentionBlockerPredicate('dirty_work', 'dirty_work.latest_source_high_water_mark')}
      GROUP BY
        projectionComponent,
        projectionIdentity,
        dirty_work.source_partition
    )
    SELECT
      projectionComponent,
      projectionIdentity,
      sourcePartition,
      completedSourceHighWaterMark
    FROM retention_ready_dirty_work retention_lane
    WHERE projectionComponent IS NOT NULL
      AND projectionIdentity IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_serving_dirty_work blocker
        WHERE ${getProjectionComponentSql('blocker')} = retention_lane.projectionComponent
          AND ${getProjectionIdentitySql('blocker')} = retention_lane.projectionIdentity
          AND blocker.source_partition = retention_lane.sourcePartition
          AND blocker.status <> 'completed'
          AND blocker.latest_source_high_water_mark <= retention_lane.completedSourceHighWaterMark
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_serving_dirty_work uncovered_completed
        WHERE ${getProjectionComponentSql('uncovered_completed')} = retention_lane.projectionComponent
          AND ${getProjectionIdentitySql('uncovered_completed')} = retention_lane.projectionIdentity
          AND uncovered_completed.source_partition = retention_lane.sourcePartition
          AND uncovered_completed.status = 'completed'
          AND uncovered_completed.latest_source_high_water_mark <= retention_lane.completedSourceHighWaterMark
          AND NOT (
            ${getProjectionComponentSql('uncovered_completed')} IS NOT NULL
            AND ${getProjectionIdentitySql('uncovered_completed')} IS NOT NULL
            AND ${getDirtyWorkSourceWatermarkAdvancedPredicate('uncovered_completed')}
            AND ${getCompletedDirtyWorkCoveredByAckPredicate('uncovered_completed')}
          )
      )
    ORDER BY projectionComponent ASC, projectionIdentity ASC, sourcePartition ASC
    LIMIT ${params.limit}
  `)
}

const deleteReviewServingDirtyWorkAcknowledgementsForRetention = async (
  params: {compactions: readonly CleanupReviewServingDirtyWorkRetentionCompaction[]; limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0 || params.compactions.length === 0) {
    return 0
  }

  const lanePredicate = params.compactions
    .map((compaction) => {
      return `(
          dirty_ack_id <> ${getSqlLiteral(compaction.dirtyAckId)}
          AND projection_component = ${getSqlLiteral(compaction.projectionComponent)}
          AND projection_identity = ${getSqlLiteral(compaction.projectionIdentity)}
          AND source_partition = ${getSqlLiteral(compaction.sourcePartition)}
          AND completed_source_high_water_mark <= ${getSqlLiteral(compaction.completedSourceHighWaterMark)}
        )`
    })
    .join('\n        OR ')

  const rows = await database.queryJson<{dirtyAckId: string}>(`
    SELECT dirty_ack_id AS dirtyAckId
    FROM app.review_serving_dirty_work_ack
    WHERE status = 'completed'
      AND (
        ${lanePredicate}
      )
    ORDER BY completed_source_high_water_mark ASC, dirty_ack_id ASC
    LIMIT ${params.limit}
  `)

  return deleteReviewServingDirtyWorkAcknowledgementsByIds(
    rows.map((row) => {
      return row.dirtyAckId
    }),
    database,
  )
}

const deleteReviewServingDirtyWorkAcknowledgementsByIds = async (
  dirtyAckIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction,
) => {
  const uniqueDirtyAckIds = [...new Set(dirtyAckIds)]

  if (uniqueDirtyAckIds.length === 0) {
    return 0
  }

  const rows = await database.queryJson<{dirtyAckId: string}>(`
    DELETE FROM app.review_serving_dirty_work_ack
    WHERE dirty_ack_id IN (
      ${uniqueDirtyAckIds.map(getSqlLiteral).join(', ')}
    )
    RETURNING dirty_ack_id AS dirtyAckId
  `)

  return rows.length
}

const deleteReviewServingDirtyWorkRowsForRetention = async (
  params: {limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  const rows = await database.queryJson<{dirtyWorkId: string}>(`
    SELECT dirty_work.dirty_work_id AS dirtyWorkId
    FROM app.review_serving_dirty_work dirty_work
    WHERE dirty_work.status = 'completed'
      AND ${getProjectionComponentSql('dirty_work')} IS NOT NULL
      AND ${getProjectionIdentitySql('dirty_work')} IS NOT NULL
      AND ${getDirtyWorkSourceWatermarkAdvancedPredicate('dirty_work')}
      AND ${getCompletedDirtyWorkCoveredByAckPredicate('dirty_work')}
      AND ${getNoLowerRetentionBlockerPredicate('dirty_work', 'dirty_work.latest_source_high_water_mark')}
    ORDER BY dirty_work.updated_at ASC, dirty_work.latest_source_high_water_mark ASC, dirty_work.dirty_work_id ASC
    LIMIT ${params.limit}
  `)

  const dirtyWorkIds = rows.map((row) => {
    return row.dirtyWorkId
  })

  if (dirtyWorkIds.length === 0) {
    return 0
  }

  const deletedRows = await database.queryJson<{dirtyWorkId: string}>(`
    DELETE FROM app.review_serving_dirty_work
    WHERE dirty_work_id IN (
      ${dirtyWorkIds.map(getSqlLiteral).join(', ')}
    )
    RETURNING dirty_work_id AS dirtyWorkId
  `)

  return deletedRows.length
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

  const rows = await database.queryJson<DirtyWorkRow>(`
    WITH repair_cursor AS (
      SELECT COALESCE(MAX(storage_row_id), -1) AS max_storage_row_id
      FROM app.review_serving_dirty_work_claim_state
      WHERE storage_row_id IS NOT NULL
    )
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
    FROM app.review_serving_dirty_work dirty_work, repair_cursor
    WHERE dirty_work.rowid > repair_cursor.max_storage_row_id
      AND status IN ('pending', 'running', 'failed')
    ORDER BY dirty_work.rowid ASC
    LIMIT ${params.limit}
  `)

  await maintainReviewServingDirtyWorkClaimStates(rows.map(getDirtyWorkRecordFromRow), database)

  return rows.length
}

const coalesceReviewServingDirtyWorkHighWaterRows = async (
  params: {limit: number},
  database: ReviewServingDirtyWorkTransaction,
) => {
  if (params.limit === 0) {
    return 0
  }

  let coalescedCount = 0

  while (coalescedCount < params.limit) {
    const [candidate] = await database.queryJson<DirtyWorkClaimStateRow>(`
      SELECT
        older.dirty_work_id AS dirtyWorkId,
        older.storage_row_id AS storageRowId,
        older.project_id AS projectId,
        older.projection_component AS projectionComponent,
        older.projection_identity AS projectionIdentity,
        older.source_partition AS sourcePartition,
        older.status,
        older.latest_source_high_water_mark AS latestSourceHighWaterMark,
        older.dirty_range_start AS dirtyRangeStart,
        older.dirty_range_end AS dirtyRangeEnd,
        older.updated_at AS updatedAt
      FROM app.review_serving_dirty_work_claim_state older
      WHERE older.status = 'pending'
        AND older.dirty_range_start IS NULL
        AND older.dirty_range_end IS NULL
        AND EXISTS (
          SELECT 1
          FROM app.review_serving_dirty_work_claim_state newer
          WHERE newer.project_id = older.project_id
            AND newer.projection_component = older.projection_component
            AND newer.projection_identity = older.projection_identity
            AND newer.source_partition = older.source_partition
            AND newer.status IN ('pending', 'running')
            AND newer.dirty_range_start IS NULL
            AND newer.dirty_range_end IS NULL
            AND (
              newer.latest_source_high_water_mark > older.latest_source_high_water_mark
              OR newer.updated_at > older.updated_at
              OR newer.dirty_work_id > older.dirty_work_id
            )
        )
      ORDER BY older.updated_at ASC, older.latest_source_high_water_mark ASC, older.dirty_work_id ASC
      LIMIT 1
    `)

    if (candidate === undefined) {
      return coalescedCount
    }

    const coalescedRows = await database.queryJson<DirtyWorkRow>(`
      UPDATE app.review_serving_dirty_work
      SET status = 'completed', lifecycle_reason = 'superseded_by_high_water', updated_at = current_timestamp
      WHERE ${getDirtyWorkClaimStatePredicate([candidate])}
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

    if (coalescedRows.length === 0) {
      return coalescedCount
    }

    coalescedCount += coalescedRows.length
  }

  return coalescedCount
}

export const cleanupReviewServingDirtyWorkRetention = async (
  params: CleanupReviewServingDirtyWorkRetentionParams = {},
  database: ReviewServingDirtyWorkDatabase = getAppDatabaseService() as ReviewServingDirtyWorkDatabase,
): Promise<CleanupReviewServingDirtyWorkRetentionResult> => {
  const laneCompactionLimit = getNormalizedCleanupLimit(params.laneCompactionLimit, 0)
  const acknowledgementDeleteLimit = getNormalizedCleanupLimit(params.acknowledgementDeleteLimit, 0)
  const coalesceDirtyWorkLimit = getNormalizedCleanupLimit(params.coalesceDirtyWorkLimit, 64)
  const dirtyWorkDeleteLimit = getNormalizedCleanupLimit(params.dirtyWorkDeleteLimit, 0)
  const laneRepairLimit = getNormalizedCleanupLimit(params.laneRepairLimit, 0)
  const laneStateRepairLimit = getNormalizedCleanupLimit(params.laneStateRepairLimit, 256)

  return database.transaction(async (tx) => {
    const repairedLaneColumnCount = await repairReviewServingDirtyWorkLaneColumns({limit: laneRepairLimit}, tx)
    const repairedLaneStateCount = await repairReviewServingDirtyWorkLaneState({limit: laneStateRepairLimit}, tx)
    const coalescedDirtyWorkCount = await coalesceReviewServingDirtyWorkHighWaterRows(
      {limit: coalesceDirtyWorkLimit},
      tx,
    )
    const lanes = await getReviewServingDirtyWorkRetentionLanes({limit: laneCompactionLimit}, tx)
    const deletedDirtyWorkCount = await deleteReviewServingDirtyWorkRowsForRetention({limit: dirtyWorkDeleteLimit}, tx)
    const compactedAcknowledgements = await lanes.reduce<Promise<CleanupReviewServingDirtyWorkRetentionCompaction[]>>(
      async (previousCompactions, lane) => {
        const compactions = await previousCompactions
        const dirtyAckId = getDirtyAckHighWaterId(lane)

        if (await reserveReviewServingDirtyAckId(dirtyAckId, tx)) {
          await tx.run(`
            INSERT INTO app.review_serving_dirty_work_ack (
              dirty_ack_id,
              dirty_work_id,
              projection_component,
              projection_identity,
              source_partition,
              completed_source_high_water_mark,
              dirty_range_start,
              dirty_range_end,
              status,
              completed_at
            )
            VALUES (
              ${getSqlLiteral(dirtyAckId)},
              NULL,
              ${getSqlLiteral(lane.projectionComponent)},
              ${getSqlLiteral(lane.projectionIdentity)},
              ${getSqlLiteral(lane.sourcePartition)},
              ${getSqlLiteral(lane.completedSourceHighWaterMark)},
              NULL,
              NULL,
              'completed',
              current_timestamp
            )
          `)
        }

        return [...compactions, {...lane, dirtyAckId}]
      },
      Promise.resolve([]),
    )

    const deletedAcknowledgementCount = await deleteReviewServingDirtyWorkAcknowledgementsForRetention(
      {compactions: compactedAcknowledgements, limit: acknowledgementDeleteLimit},
      tx,
    )

    return {
      coalescedDirtyWorkCount,
      compactedAcknowledgements,
      compactedLaneCount: compactedAcknowledgements.length,
      deletedAcknowledgementCount,
      deletedDirtyWorkCount,
      repairedLaneColumnCount,
      repairedLaneStateCount,
    }
  })
}

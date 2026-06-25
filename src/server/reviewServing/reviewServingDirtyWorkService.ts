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

export type CompactReviewServingDirtyWorkAcknowledgementsParams = {
  completedSourceHighWaterMark: number
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  sourcePartition: string
}

export type ReviewServingDirtyWorkClaim = {
  articleId: string | null
  dirtyKind: string
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string
  firstSourceHighWaterMark: number
  latestDeltaId: string | null
  latestSourceHighWaterMark: number
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  scopeId: string
  scopeKind: string
  sourcePartition: string
  status: ReviewServingDirtyWorkStatus
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
  projectId: string | null
  projectionKey: string | null
  scopeId: string
  scopeKind: string
  sourcePartition: string
  status: ReviewServingDirtyWorkStatus
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

const getProjectionKeyPrefix = (projectionComponent: ReviewServingProjectionComponent) => {
  return getStableReviewServingJson({projectionComponent}).replace(/\}$/u, ',"projectionIdentity":')
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
    AND starts_with(projection_key, ${getSqlLiteral(getProjectionKeyPrefix(params.projectionComponent))})`
}

const getLowerWatermarkLaneBlockerPredicate = (params: ClaimReviewServingDirtyWorkParams, claimNowSql: string) => {
  const staleRunningClaimSeconds = getStaleRunningClaimSeconds(params)

  return `NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work blocker
      WHERE blocker.projection_key = app.review_serving_dirty_work.projection_key
        AND blocker.source_partition = app.review_serving_dirty_work.source_partition
        AND blocker.status IN ('running', 'failed')
        AND blocker.updated_at > ${claimNowSql} - INTERVAL '${staleRunningClaimSeconds} seconds'
        AND blocker.latest_source_high_water_mark < app.review_serving_dirty_work.latest_source_high_water_mark
    )`
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

const getStaleRunningClaimSeconds = (params: ClaimReviewServingDirtyWorkParams) => {
  return Math.max(0, Math.floor(params.staleRunningClaimSeconds ?? 15 * 60))
}

const getClaimNowSql = (params: ClaimReviewServingDirtyWorkParams) => {
  return params.now === undefined ? 'current_timestamp' : `TIMESTAMPTZ ${getSqlLiteral(params.now.toISOString())}`
}

const getArticleId = (input: ReviewServingDirtyWorkInput) => {
  const explicitArticleId = input.articleId?.trim()

  return explicitArticleId && explicitArticleId.length > 0
    ? explicitArticleId
    : input.scope.scopeKind === 'article'
      ? (input.scope.scopeId.split(':').at(-1) ?? null)
      : null
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
    projectId: row.projectId,
    projectionComponent: projection?.projectionComponent ?? 'display',
    projectionIdentity: projection?.projectionIdentity ?? '',
    scopeId: row.scopeId,
    scopeKind: row.scopeKind,
    sourcePartition: row.sourcePartition,
    status: row.status,
    updatedAt: getDateValue(row.updatedAt),
  }
}

const getDirtyWorkSelect = () => {
  return `
    SELECT
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
      latest_delta_id AS latestDeltaId,
      dirty_range_start AS dirtyRangeStart,
      dirty_range_end AS dirtyRangeEnd,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.review_serving_dirty_work
  `
}

const getAcknowledgedDirtyRangeCondition = (input: ReviewServingDirtyWorkInput) => {
  const dirtyRangeStart = input.scope.dirtyRangeStart
  const dirtyRangeEnd = input.scope.dirtyRangeEnd

  return dirtyRangeStart === null || dirtyRangeEnd === null
    ? 'dirty_range_start IS NULL AND dirty_range_end IS NULL'
    : `(
        dirty_range_start IS NULL
        OR (
          dirty_range_start <= ${getSqlLiteral(dirtyRangeStart)}
          AND dirty_range_end >= ${getSqlLiteral(dirtyRangeEnd)}
        )
      )`
}

const isReviewServingDirtyWorkAcknowledged = async (
  input: ReviewServingDirtyWorkInput,
  database: ReviewServingDirtyWorkTransaction,
) => {
  const rows = await database.queryJson<{acknowledged: boolean}>(`
    SELECT true AS acknowledged
    FROM app.review_serving_dirty_work_ack
    WHERE projection_component = ${getSqlLiteral(input.projectionComponent)}
      AND projection_identity = ${getSqlLiteral(input.projectionIdentity)}
      AND source_partition = ${getSqlLiteral(input.scope.sourcePartition)}
      AND status = 'completed'
      AND completed_source_high_water_mark >= ${input.scope.sourceHighWaterMark}
      AND (${getAcknowledgedDirtyRangeCondition(input)})
    LIMIT 1
  `)

  return rows.length > 0
}

const acknowledgeReviewServingDirtyWorkClaim = async (
  claim: ReviewServingDirtyWorkClaim,
  database: ReviewServingDirtyWorkTransaction,
) => {
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
    ) VALUES (
      ${getSqlLiteral(getDirtyAckId(claim))},
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
    ON CONFLICT(dirty_ack_id) DO NOTHING
  `)
}

export const upsertReviewServingDirtyWork = async (
  input: ReviewServingDirtyWorkInput,
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const dirtyWorkId = getDirtyWorkId(input)
  const skipped = await isReviewServingDirtyWorkAcknowledged(input, database)

  if (skipped) {
    return {dirtyWorkId, skipped}
  }

  const projectionKey = getProjectionKey({
    projectionComponent: input.projectionComponent,
    projectionIdentity: input.projectionIdentity,
  })

  await database.run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id,
      project_id,
      scope_kind,
      scope_id,
      article_id,
      projection_key,
      dirty_kind,
      source_partition,
      first_source_high_water_mark,
      latest_source_high_water_mark,
      latest_delta_id,
      dirty_range_start,
      dirty_range_end,
      status,
      updated_at
    ) VALUES (
      ${getSqlLiteral(dirtyWorkId)},
      ${getSqlLiteral(input.scope.projectId)},
      ${getSqlLiteral(input.scope.scopeKind)},
      ${getSqlLiteral(input.scope.scopeId)},
      ${getSqlLiteral(getArticleId(input))},
      ${getSqlLiteral(projectionKey)},
      ${getSqlLiteral(input.scope.dirtyKind)},
      ${getSqlLiteral(input.scope.sourcePartition)},
      ${getSqlLiteral(input.scope.sourceHighWaterMark)},
      ${getSqlLiteral(input.scope.sourceHighWaterMark)},
      ${getSqlLiteral(input.latestDeltaId ?? null)},
      ${getSqlLiteral(input.scope.dirtyRangeStart)},
      ${getSqlLiteral(input.scope.dirtyRangeEnd)},
      'pending',
      current_timestamp
    )
    ON CONFLICT(dirty_work_id) DO UPDATE SET
      first_source_high_water_mark = LEAST(
        app.review_serving_dirty_work.first_source_high_water_mark,
        excluded.first_source_high_water_mark
      ),
      latest_source_high_water_mark = GREATEST(
        app.review_serving_dirty_work.latest_source_high_water_mark,
        excluded.latest_source_high_water_mark
      ),
      latest_delta_id = excluded.latest_delta_id,
      dirty_range_start = CASE
        WHEN app.review_serving_dirty_work.dirty_range_start IS NULL THEN excluded.dirty_range_start
        WHEN excluded.dirty_range_start IS NULL THEN app.review_serving_dirty_work.dirty_range_start
        ELSE LEAST(app.review_serving_dirty_work.dirty_range_start, excluded.dirty_range_start)
      END,
      dirty_range_end = CASE
        WHEN app.review_serving_dirty_work.dirty_range_end IS NULL THEN excluded.dirty_range_end
        WHEN excluded.dirty_range_end IS NULL THEN app.review_serving_dirty_work.dirty_range_end
        ELSE GREATEST(app.review_serving_dirty_work.dirty_range_end, excluded.dirty_range_end)
      END,
      status = 'pending',
      updated_at = excluded.updated_at
  `)

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
  const laneBlockerPredicate = getLowerWatermarkLaneBlockerPredicate(params, claimNowSql)

  return limit === 0
    ? []
    : database.transaction(async (tx) => {
        const rows = await tx.queryJson<DirtyWorkRow>(`
          ${getDirtyWorkSelect()}
          WHERE ${eligiblePredicate}
            AND ${laneBlockerPredicate}
            AND source_partition = (
              SELECT source_partition
              FROM app.review_serving_dirty_work oldest
              WHERE ${eligiblePredicate}
              ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
              LIMIT 1
            )
            AND projection_key = (
              SELECT projection_key
              FROM app.review_serving_dirty_work oldest
              WHERE ${eligiblePredicate}
              ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
              LIMIT 1
            )
          ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
          LIMIT ${limit}
        `)
        const claims = rows.map(getDirtyWorkRecordFromRow)
        const dirtyWorkIds = claims.map((claim) => {
          return claim.dirtyWorkId
        })

        if (dirtyWorkIds.length > 0) {
          await tx.run(`
            UPDATE app.review_serving_dirty_work
            SET status = 'running', updated_at = current_timestamp
            WHERE dirty_work_id IN (${dirtyWorkIds.map(getSqlLiteral).join(', ')})
              AND ${eligiblePredicate}
          `)
        }

        return claims.map((claim) => {
          return {...claim, status: 'running' as const}
        })
      })
}

export const releaseReviewServingDirtyWorkClaims = async (
  dirtyWorkIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const uniqueDirtyWorkIds = [...new Set(dirtyWorkIds)]

  if (uniqueDirtyWorkIds.length > 0) {
    await database.run(`
      UPDATE app.review_serving_dirty_work
      SET status = 'pending', updated_at = current_timestamp
      WHERE dirty_work_id IN (${uniqueDirtyWorkIds.map(getSqlLiteral).join(', ')})
        AND status = 'running'
    `)
  }

  return {releasedCount: uniqueDirtyWorkIds.length}
}

export const failReviewServingDirtyWorkClaims = async (
  dirtyWorkIds: readonly string[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
) => {
  const uniqueDirtyWorkIds = [...new Set(dirtyWorkIds)]

  if (uniqueDirtyWorkIds.length > 0) {
    await database.run(`
      UPDATE app.review_serving_dirty_work
      SET status = 'failed', updated_at = current_timestamp
      WHERE dirty_work_id IN (${uniqueDirtyWorkIds.map(getSqlLiteral).join(', ')})
        AND status = 'running'
    `)
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
    await database.run(`
      UPDATE app.review_serving_dirty_work
      SET status = 'completed', updated_at = current_timestamp
      WHERE dirty_work_id IN (${uniqueClaims
        .map((claim) => {
          return getSqlLiteral(claim.dirtyWorkId)
        })
        .join(', ')})
        AND status = 'running'
    `)
  }

  return {completedCount: uniqueClaims.length}
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
    ) VALUES (
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
    ON CONFLICT(dirty_ack_id) DO UPDATE SET
      completed_source_high_water_mark = GREATEST(
        app.review_serving_dirty_work_ack.completed_source_high_water_mark,
        excluded.completed_source_high_water_mark
      ),
      completed_at = excluded.completed_at
  `)

  await database.run(`
    DELETE FROM app.review_serving_dirty_work_ack
    WHERE dirty_ack_id <> ${getSqlLiteral(dirtyAckId)}
      AND dirty_work_id IS NOT NULL
      AND projection_component = ${getSqlLiteral(input.projectionComponent)}
      AND projection_identity = ${getSqlLiteral(input.projectionIdentity)}
      AND source_partition = ${getSqlLiteral(input.sourcePartition)}
      AND status = 'completed'
      AND completed_source_high_water_mark <= ${input.completedSourceHighWaterMark}
  `)

  return {compactedThroughHighWaterMark: input.completedSourceHighWaterMark, dirtyAckId}
}

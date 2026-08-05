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

export const defaultReviewServingDirtyWorkStaleClaimSeconds = 15 * 60
const reviewServingDirtyWorkLaneWindowLimit = 2_048

export type CompactReviewServingDirtyWorkAcknowledgementsParams = {
  completedSourceHighWaterMark: number
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  sourcePartition: string
}

export type CleanupReviewServingDirtyWorkRetentionParams = {
  acknowledgementDeleteLimit?: number
  dirtyWorkDeleteLimit?: number
  laneCompactionLimit?: number
}

export type CleanupReviewServingDirtyWorkRetentionCompaction = CompactReviewServingDirtyWorkAcknowledgementsParams & {
  dirtyAckId: string
}

export type CleanupReviewServingDirtyWorkRetentionResult = {
  compactedAcknowledgements: CleanupReviewServingDirtyWorkRetentionCompaction[]
  compactedLaneCount: number
  deletedAcknowledgementCount: number
  deletedDirtyWorkCount: number
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

type DirtyWorkSourceWatermarkCompletion = {
  projectId: string | null
  sourceHighWaterMark: number
  sourcePartition: string
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

const getLowerWatermarkLaneBlockerPredicate = (
  params: ClaimReviewServingDirtyWorkParams,
  claimNowSql: string,
  dirtyWorkSql = 'app.review_serving_dirty_work',
) => {
  const staleRunningClaimSeconds = getStaleRunningClaimSeconds(params)

  return `NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work blocker
      WHERE blocker.projection_key = ${dirtyWorkSql}.projection_key
        AND blocker.source_partition = ${dirtyWorkSql}.source_partition
        AND blocker.status IN ('running', 'failed')
        AND blocker.updated_at > ${claimNowSql} - INTERVAL '${staleRunningClaimSeconds} seconds'
        AND blocker.latest_source_high_water_mark < ${dirtyWorkSql}.latest_source_high_water_mark
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

const getQualifiedDirtyWorkSelect = (dirtyWorkSql: string) => {
  return `
    SELECT
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
      ${dirtyWorkSql}.latest_delta_id AS latestDeltaId,
      ${dirtyWorkSql}.dirty_range_start AS dirtyRangeStart,
      ${dirtyWorkSql}.dirty_range_end AS dirtyRangeEnd,
      ${dirtyWorkSql}.status,
      ${dirtyWorkSql}.created_at AS createdAt,
      ${dirtyWorkSql}.updated_at AS updatedAt
    FROM app.review_serving_dirty_work ${dirtyWorkSql}
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
    )
    SELECT *
    FROM (
      VALUES (
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
    ) AS incoming(
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
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work_ack existing
      WHERE existing.dirty_ack_id = incoming.dirty_ack_id
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
    AND ${dirtyWorkSql}.projection_key = coverage.projection_key
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

  const valuesSql = coverages
    .map((coverage) => {
      return `(
        ${getSqlLiteral(
          getDirtyAckHighWaterId({
            completedSourceHighWaterMark: coverage.completedSourceHighWaterMark,
            projectionComponent: coverage.projectionComponent,
            projectionIdentity: coverage.projectionIdentity,
            sourcePartition: coverage.sourcePartition,
          }),
        )},
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
    SELECT *
    FROM (
      VALUES
      ${valuesSql}
    ) AS incoming(
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
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work_ack existing
      WHERE existing.dirty_ack_id = incoming.dirty_ack_id
    )
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
      updated_at = current_timestamp
    WHERE dirty_work_id = ${getSqlLiteral(dirtyWorkId)}
  `)

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
    )
    SELECT
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
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work existing
      WHERE (existing.dirty_work_id || '') = (${getSqlLiteral(dirtyWorkId)} || '')
    )
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

  if (limit === 0) {
    return []
  }

  const rows = await database.queryJson<DirtyWorkRow>(`
    WITH claim_lane_window AS (
      SELECT dirty_work_id, source_partition, projection_key, updated_at, latest_source_high_water_mark
      FROM app.review_serving_dirty_work
      WHERE ${eligiblePredicate}
      ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
      LIMIT ${reviewServingDirtyWorkLaneWindowLimit}
    ),
    eligible_lane AS (
      SELECT source_partition, projection_key
      FROM claim_lane_window oldest
      WHERE ${getLowerWatermarkLaneBlockerPredicate(params, claimNowSql, 'oldest')}
      ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
      LIMIT 1
    ),
    claim_candidate_window AS (
      SELECT dirty_work_id, source_partition, projection_key, updated_at, latest_source_high_water_mark
      FROM app.review_serving_dirty_work
      WHERE ${eligiblePredicate}
        AND EXISTS (
          SELECT 1
          FROM eligible_lane
          WHERE eligible_lane.source_partition = app.review_serving_dirty_work.source_partition
            AND eligible_lane.projection_key = app.review_serving_dirty_work.projection_key
        )
      ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
      LIMIT ${reviewServingDirtyWorkLaneWindowLimit}
    ),
    claim_candidates AS (
      SELECT dirty_work_id
      FROM claim_candidate_window candidate
      WHERE ${getLowerWatermarkLaneBlockerPredicate(params, claimNowSql, 'candidate')}
      ORDER BY updated_at ASC, latest_source_high_water_mark ASC, dirty_work_id ASC
      LIMIT ${limit}
    )
    UPDATE app.review_serving_dirty_work
    SET status = 'running', updated_at = current_timestamp
    WHERE dirty_work_id IN (
      SELECT dirty_work_id
      FROM claim_candidates
    )
      AND ${eligiblePredicate}
    RETURNING
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
  `)
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
    await advanceReviewServingDirtySourceWatermark(uniqueClaims, database)

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

export const completeReviewServingDirtyWorkCoveredByRebuild = async (
  coverages: readonly ReviewServingDirtyWorkCoverage[],
  database: ReviewServingDirtyWorkTransaction = getAppDatabaseService(),
): Promise<CompleteReviewServingDirtyWorkCoverageResult> => {
  const normalizedCoverages = getNormalizedDirtyWorkCoverages(coverages)

  if (normalizedCoverages.length === 0) {
    return {completedCount: 0}
  }

  const coverageCteSql = getDirtyWorkCoverageCteSql(normalizedCoverages)
  const rows = await database.queryJson<DirtyWorkRow>(`
    WITH rebuild_dirty_work_coverage AS (
      ${coverageCteSql}
    )
    ${getQualifiedDirtyWorkSelect('dirty_work')}
    INNER JOIN rebuild_dirty_work_coverage coverage
      ON ${getDirtyWorkCoverageMatchSql('dirty_work')}
    WHERE dirty_work.status <> 'completed'
  `)
  const coveredClaims = rows.map(getDirtyWorkRecordFromRow)
  const highWaterAckCoverages = getHighWaterAckCoverages(normalizedCoverages)
  const pointAckClaims = coveredClaims.filter((claim) => {
    return !isClaimCoveredByHighWaterAckCoverage(claim, highWaterAckCoverages)
  })

  await pointAckClaims.reduce<Promise<void>>((previousCompletion, claim) => {
    return previousCompletion.then(async () => {
      await acknowledgeReviewServingDirtyWorkClaim(claim, database)
    })
  }, Promise.resolve())

  await insertReviewServingDirtyWorkCoverageAcknowledgements(highWaterAckCoverages, database)

  await advanceReviewServingDirtySourceWatermarkEntries(
    [
      ...coveredClaims.map((claim) => {
        return {
          projectId: claim.projectId,
          sourceHighWaterMark: claim.latestSourceHighWaterMark,
          sourcePartition: claim.sourcePartition,
        }
      }),
      ...highWaterAckCoverages.map((coverage) => {
        return {
          projectId: coverage.projectId,
          sourceHighWaterMark: coverage.completedSourceHighWaterMark,
          sourcePartition: coverage.sourcePartition,
        }
      }),
    ],
    database,
  )

  await database.run(`
    WITH rebuild_dirty_work_coverage AS (
      ${coverageCteSql}
    )
    UPDATE app.review_serving_dirty_work
    SET status = 'completed', updated_at = current_timestamp
    FROM rebuild_dirty_work_coverage coverage
    WHERE ${getDirtyWorkCoverageMatchSql('app.review_serving_dirty_work')}
      AND app.review_serving_dirty_work.status <> 'completed'
  `)

  return {completedCount: coveredClaims.length}
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
    )
    SELECT *
    FROM (
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
    ) AS incoming(
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
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_serving_dirty_work_ack existing
      WHERE existing.dirty_ack_id = incoming.dirty_ack_id
    )
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

const getCompletedDirtyWorkCoveredByAckPredicate = (dirtyWorkSql: string) => {
  const projectionComponentSql = `json_extract_string(${dirtyWorkSql}.projection_key, '$.projectionComponent')`
  const projectionIdentitySql = `json_extract_string(${dirtyWorkSql}.projection_key, '$.projectionIdentity')`

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
      WHERE json_extract_string(blocker.projection_key, '$.projectionComponent')
          = json_extract_string(${dirtyWorkSql}.projection_key, '$.projectionComponent')
        AND json_extract_string(blocker.projection_key, '$.projectionIdentity')
          = json_extract_string(${dirtyWorkSql}.projection_key, '$.projectionIdentity')
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
        json_extract_string(dirty_work.projection_key, '$.projectionComponent') AS projectionComponent,
        json_extract_string(dirty_work.projection_key, '$.projectionIdentity') AS projectionIdentity,
        dirty_work.source_partition AS sourcePartition,
        MAX(dirty_work.latest_source_high_water_mark) AS completedSourceHighWaterMark
      FROM app.review_serving_dirty_work dirty_work
      WHERE dirty_work.status = 'completed'
        AND dirty_work.projection_key IS NOT NULL
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
        WHERE json_extract_string(blocker.projection_key, '$.projectionComponent') = retention_lane.projectionComponent
          AND json_extract_string(blocker.projection_key, '$.projectionIdentity') = retention_lane.projectionIdentity
          AND blocker.source_partition = retention_lane.sourcePartition
          AND blocker.status <> 'completed'
          AND blocker.latest_source_high_water_mark <= retention_lane.completedSourceHighWaterMark
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_serving_dirty_work uncovered_completed
        WHERE json_extract_string(uncovered_completed.projection_key, '$.projectionComponent')
            = retention_lane.projectionComponent
          AND json_extract_string(uncovered_completed.projection_key, '$.projectionIdentity')
            = retention_lane.projectionIdentity
          AND uncovered_completed.source_partition = retention_lane.sourcePartition
          AND uncovered_completed.status = 'completed'
          AND uncovered_completed.latest_source_high_water_mark <= retention_lane.completedSourceHighWaterMark
          AND NOT (
            uncovered_completed.projection_key IS NOT NULL
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
    DELETE FROM app.review_serving_dirty_work_ack
    WHERE dirty_ack_id IN (
      SELECT dirty_ack_id
      FROM app.review_serving_dirty_work_ack
      WHERE status = 'completed'
        AND (
          ${lanePredicate}
        )
      ORDER BY completed_source_high_water_mark ASC, dirty_ack_id ASC
      LIMIT ${params.limit}
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
    DELETE FROM app.review_serving_dirty_work
    WHERE dirty_work_id IN (
      SELECT dirty_work.dirty_work_id
      FROM app.review_serving_dirty_work dirty_work
      WHERE dirty_work.status = 'completed'
        AND dirty_work.projection_key IS NOT NULL
        AND ${getDirtyWorkSourceWatermarkAdvancedPredicate('dirty_work')}
        AND ${getCompletedDirtyWorkCoveredByAckPredicate('dirty_work')}
        AND ${getNoLowerRetentionBlockerPredicate('dirty_work', 'dirty_work.latest_source_high_water_mark')}
      ORDER BY dirty_work.updated_at ASC, dirty_work.latest_source_high_water_mark ASC, dirty_work.dirty_work_id ASC
      LIMIT ${params.limit}
    )
    RETURNING dirty_work_id AS dirtyWorkId
  `)

  return rows.length
}

export const cleanupReviewServingDirtyWorkRetention = async (
  params: CleanupReviewServingDirtyWorkRetentionParams = {},
  database: ReviewServingDirtyWorkDatabase = getAppDatabaseService() as ReviewServingDirtyWorkDatabase,
): Promise<CleanupReviewServingDirtyWorkRetentionResult> => {
  const laneCompactionLimit = getNormalizedCleanupLimit(params.laneCompactionLimit, 50)
  const acknowledgementDeleteLimit = getNormalizedCleanupLimit(params.acknowledgementDeleteLimit, 1000)
  const dirtyWorkDeleteLimit = getNormalizedCleanupLimit(params.dirtyWorkDeleteLimit, 1000)

  return database.transaction(async (tx) => {
    const lanes = await getReviewServingDirtyWorkRetentionLanes({limit: laneCompactionLimit}, tx)
    const deletedDirtyWorkCount = await deleteReviewServingDirtyWorkRowsForRetention({limit: dirtyWorkDeleteLimit}, tx)
    const compactedAcknowledgements = await lanes.reduce<Promise<CleanupReviewServingDirtyWorkRetentionCompaction[]>>(
      async (previousCompactions, lane) => {
        const compactions = await previousCompactions
        const dirtyAckId = getDirtyAckHighWaterId(lane)

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
        SELECT *
        FROM (
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
        ) AS incoming(
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
        WHERE NOT EXISTS (
          SELECT 1
          FROM app.review_serving_dirty_work_ack existing
          WHERE existing.dirty_ack_id = incoming.dirty_ack_id
        )
      `)

        return [...compactions, {...lane, dirtyAckId}]
      },
      Promise.resolve([]),
    )

    const deletedAcknowledgementCount = await deleteReviewServingDirtyWorkAcknowledgementsForRetention(
      {compactions: compactedAcknowledgements, limit: acknowledgementDeleteLimit},
      tx,
    )

    return {
      compactedAcknowledgements,
      compactedLaneCount: compactedAcknowledgements.length,
      deletedAcknowledgementCount,
      deletedDirtyWorkCount,
    }
  })
}

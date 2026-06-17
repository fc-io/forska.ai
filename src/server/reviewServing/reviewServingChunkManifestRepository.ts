import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'

export type ReviewServingChunkManifestRepositoryTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingChunkManifestRepositoryDatabase = ReviewServingChunkManifestRepositoryTransaction & {
  transaction: <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingRebuildChunkStatus = 'pending' | 'running' | 'completed' | 'failed'

export type ReviewServingRebuildChunkIdentity = {
  chunkEndKey: string
  chunkStartKey: string
  inputDigest: string | null
  inputWatermark: number
  outputBaseGeneration: number
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
}

export type ReviewServingRebuildChunkManifest = ReviewServingRebuildChunkIdentity & {
  checksum: string | null
  chunkId: string
  completedAt: string | null
  createdAt: string
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  startedAt: string | null
  status: ReviewServingRebuildChunkStatus
  updatedAt: string
}

export type ReviewServingRebuildChunkManifestInput = ReviewServingRebuildChunkIdentity & {
  checksum?: string | null
  status?: ReviewServingRebuildChunkStatus
}

export type ReviewServingRebuildChunkValidationResult = {
  actualChecksum: string
  actualCount?: number
  expectedChecksum: string
  expectedCount?: number
}

type ReviewServingRebuildChunkManifestRow = {
  checksum: string | null
  chunkEndKey: string
  chunkId: string
  chunkStartKey: string
  completedAt: string | null
  createdAt: string
  inputDigest: string | null
  inputWatermark: number
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  outputBaseGeneration: number
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  startedAt: string | null
  status: ReviewServingRebuildChunkStatus
  updatedAt: string
}

const getReviewServingChunkManifestDatabase = () => {
  return getAppDatabaseService() as ReviewServingChunkManifestRepositoryDatabase
}

const getReviewServingChunkTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

export const getReviewServingRebuildChunkId = (input: ReviewServingRebuildChunkIdentity) => {
  return `chunk:${createHash('sha256')
    .update(
      getStableReviewServingJson({
        chunkEndKey: input.chunkEndKey,
        chunkStartKey: input.chunkStartKey,
        inputDigest: input.inputDigest,
        inputWatermark: input.inputWatermark,
        outputBaseGeneration: input.outputBaseGeneration,
        projectId: input.projectId,
        projectionComponent: input.projectionComponent,
        projectionIdentity: input.projectionIdentity,
      }),
    )
    .digest('hex')
    .slice(0, 32)}`
}

const getReviewServingRebuildChunkManifestFromRow = (
  row: ReviewServingRebuildChunkManifestRow,
): ReviewServingRebuildChunkManifest => {
  return {
    checksum: row.checksum,
    chunkEndKey: row.chunkEndKey,
    chunkId: row.chunkId,
    chunkStartKey: row.chunkStartKey,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    inputDigest: row.inputDigest,
    inputWatermark: Number(row.inputWatermark),
    lastError: row.lastError,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseOwner: row.leaseOwner,
    outputBaseGeneration: Number(row.outputBaseGeneration),
    projectId: row.projectId,
    projectionComponent: row.projectionComponent,
    projectionIdentity: row.projectionIdentity,
    startedAt: row.startedAt,
    status: row.status,
    updatedAt: row.updatedAt,
  }
}

const getReviewServingRebuildChunkSelect = () => {
  return `
    SELECT
      chunk_id AS chunkId,
      project_id AS projectId,
      projection_component AS projectionComponent,
      projection_identity AS projectionIdentity,
      input_digest AS inputDigest,
      input_watermark AS inputWatermark,
      chunk_start_key AS chunkStartKey,
      chunk_end_key AS chunkEndKey,
      output_base_generation AS outputBaseGeneration,
      status,
      checksum,
      lease_owner AS leaseOwner,
      lease_expires_at AS leaseExpiresAt,
      last_error AS lastError,
      started_at AS startedAt,
      completed_at AS completedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.review_rebuild_chunk_manifest
  `
}

const getReviewServingRebuildChunkIdentityPredicate = (input: ReviewServingRebuildChunkIdentity) => {
  return `
    project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
    AND projection_component = ${getSqlLiteral(input.projectionComponent)}
    AND projection_identity = ${getSqlLiteral(input.projectionIdentity)}
    AND input_digest IS NOT DISTINCT FROM ${getSqlLiteral(input.inputDigest)}
    AND input_watermark = ${getSqlLiteral(input.inputWatermark)}
    AND chunk_start_key = ${getSqlLiteral(input.chunkStartKey)}
    AND chunk_end_key = ${getSqlLiteral(input.chunkEndKey)}
    AND output_base_generation = ${getSqlLiteral(input.outputBaseGeneration)}
  `
}

const getReviewServingRebuildChunkClaimPredicate = (input: {now: Date | string}) => {
  return `
    status IN ('pending', 'failed')
    OR (status = 'running' AND lease_expires_at <= ${getReviewServingChunkTimestampLiteral(input.now)})
  `
}

const getReviewServingRebuildChunkValidationError = (input: ReviewServingRebuildChunkValidationResult) => {
  const checksumValid = input.actualChecksum === input.expectedChecksum
  const countValid = input.expectedCount === undefined || input.actualCount === input.expectedCount

  return checksumValid && countValid
    ? null
    : `chunk validation failed: expected checksum ${input.expectedChecksum} and count ${input.expectedCount ?? 'n/a'}, got checksum ${input.actualChecksum} and count ${input.actualCount ?? 'n/a'}`
}

export const getReviewServingRebuildChunkManifest = async (
  input: {chunkId: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  const rows = await database.queryJson<ReviewServingRebuildChunkManifestRow>(`
    ${getReviewServingRebuildChunkSelect()}
    WHERE chunk_id = ${getSqlLiteral(input.chunkId)}
    LIMIT 1
  `)

  return rows[0] === undefined ? null : getReviewServingRebuildChunkManifestFromRow(rows[0])
}

export const getReviewServingRebuildChunkManifestForIdentity = async (
  input: ReviewServingRebuildChunkIdentity,
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  return getReviewServingRebuildChunkManifest({chunkId: getReviewServingRebuildChunkId(input)}, database)
}

export const upsertReviewServingRebuildChunkManifests = async (
  inputs: readonly ReviewServingRebuildChunkManifestInput[],
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  await Promise.all(
    inputs.map(async (input) => {
      const chunkId = getReviewServingRebuildChunkId(input)

      await database.run(`
        INSERT INTO app.review_rebuild_chunk_manifest (
          chunk_id,
          project_id,
          projection_component,
          projection_identity,
          input_digest,
          input_watermark,
          chunk_start_key,
          chunk_end_key,
          output_base_generation,
          status,
          checksum,
          updated_at
        ) VALUES (
          ${getSqlLiteral(chunkId)},
          ${getSqlLiteral(input.projectId)},
          ${getSqlLiteral(input.projectionComponent)},
          ${getSqlLiteral(input.projectionIdentity)},
          ${getSqlLiteral(input.inputDigest)},
          ${getSqlLiteral(input.inputWatermark)},
          ${getSqlLiteral(input.chunkStartKey)},
          ${getSqlLiteral(input.chunkEndKey)},
          ${getSqlLiteral(input.outputBaseGeneration)},
          ${getSqlLiteral(input.status ?? 'pending')},
          ${getSqlLiteral(input.checksum ?? null)},
          current_timestamp
        )
        ON CONFLICT(chunk_id) DO UPDATE SET
          status = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.status
            ELSE excluded.status
          END,
          checksum = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.checksum
            ELSE excluded.checksum
          END,
          lease_owner = CASE WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN lease_owner ELSE NULL END,
          lease_expires_at = CASE WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN lease_expires_at ELSE NULL END,
          last_error = CASE WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN last_error ELSE NULL END,
          updated_at = current_timestamp
      `)
    }),
  )
}

export const isReviewServingRebuildChunkComplete = async (
  input: ReviewServingRebuildChunkIdentity & {checksum?: string | null},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  const checksumPredicate =
    input.checksum === undefined ? '' : `AND checksum IS NOT DISTINCT FROM ${getSqlLiteral(input.checksum)}`
  const rows = await database.queryJson<{chunkId: string}>(`
    SELECT chunk_id AS chunkId
    FROM app.review_rebuild_chunk_manifest
    WHERE ${getReviewServingRebuildChunkIdentityPredicate(input)}
      AND status = 'completed'
      ${checksumPredicate}
    LIMIT 1
  `)

  return rows.length > 0
}

export const claimReviewServingRebuildChunk = async (
  input: ReviewServingRebuildChunkIdentity & {leaseExpiresAt: Date | string; leaseOwner: string; now: Date | string},
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingChunkManifestDatabase(),
) => {
  const chunkId = getReviewServingRebuildChunkId(input)

  return database.transaction(async (tx) => {
    await tx.run(`
      UPDATE app.review_rebuild_chunk_manifest
      SET
        status = 'running',
        lease_owner = ${getSqlLiteral(input.leaseOwner)},
        lease_expires_at = ${getReviewServingChunkTimestampLiteral(input.leaseExpiresAt)},
        last_error = NULL,
        started_at = COALESCE(started_at, current_timestamp),
        updated_at = current_timestamp
      WHERE chunk_id = ${getSqlLiteral(chunkId)}
        AND (${getReviewServingRebuildChunkClaimPredicate(input)})
    `)

    const claimed = await getReviewServingRebuildChunkManifest({chunkId}, tx)

    return claimed?.status === 'running' && claimed.leaseOwner === input.leaseOwner ? claimed : null
  })
}

export const markReviewServingRebuildChunkFailed = async (
  input: {chunkId: string; error: string; leaseOwner?: string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  const leasePredicate = input.leaseOwner ? `AND lease_owner = ${getSqlLiteral(input.leaseOwner)}` : ''

  await database.run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET
      status = 'failed',
      last_error = ${getSqlLiteral(input.error)},
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = current_timestamp
    WHERE chunk_id = ${getSqlLiteral(input.chunkId)}
      ${leasePredicate}
      AND status <> 'completed'
  `)

  return getReviewServingRebuildChunkManifest({chunkId: input.chunkId}, database)
}

export const writeReviewServingRebuildChunkOutput = async (
  input: ReviewServingRebuildChunkIdentity & {
    leaseOwner: string
    validateOutput: (
      tx: ReviewServingChunkManifestRepositoryTransaction,
    ) => Promise<ReviewServingRebuildChunkValidationResult>
    writeOutput: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<void>
  },
  database: ReviewServingChunkManifestRepositoryDatabase = getReviewServingChunkManifestDatabase(),
) => {
  const chunkId = getReviewServingRebuildChunkId(input)

  return database.transaction(async (tx) => {
    const claimed = await getReviewServingRebuildChunkManifest({chunkId}, tx)
    const canWrite = claimed?.status === 'running' && claimed.leaseOwner === input.leaseOwner

    if (!canWrite) {
      return null
    }

    await tx.run('SAVEPOINT review_serving_rebuild_chunk_output')
    await input.writeOutput(tx)

    const validation = await input.validateOutput(tx)
    const validationError = getReviewServingRebuildChunkValidationError(validation)

    if (validationError !== null) {
      await tx.run('ROLLBACK TO SAVEPOINT review_serving_rebuild_chunk_output')
      await tx.run('RELEASE SAVEPOINT review_serving_rebuild_chunk_output')

      return markReviewServingRebuildChunkFailed({chunkId, error: validationError, leaseOwner: input.leaseOwner}, tx)
    }

    await tx.run('RELEASE SAVEPOINT review_serving_rebuild_chunk_output')

    await tx.run(`
      UPDATE app.review_rebuild_chunk_manifest
      SET
        status = 'completed',
        checksum = ${getSqlLiteral(validation.actualChecksum)},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        completed_at = current_timestamp,
        updated_at = current_timestamp
      WHERE chunk_id = ${getSqlLiteral(chunkId)}
        AND status = 'running'
        AND lease_owner = ${getSqlLiteral(input.leaseOwner)}
    `)

    return getReviewServingRebuildChunkManifest({chunkId}, tx)
  })
}

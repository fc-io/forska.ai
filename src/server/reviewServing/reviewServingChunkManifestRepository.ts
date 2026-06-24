import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'

export type ReviewServingChunkManifestRepositoryTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingChunkManifestRepositoryDatabase = ReviewServingChunkManifestRepositoryTransaction & {
  transaction: <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => Promise<T>
}

export type ReviewServingRebuildChunkStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked_over_budget'
  | 'quarantined'

export type ReviewServingRebuildChunkAdmissionState = 'admitted' | 'blocked_over_budget' | 'pending'

export type ReviewServingRebuildChunkBudgetFields = {
  actualInputRows?: number | null
  actualOutputBytes?: number | null
  actualOutputRows?: number | null
  actualPayloadBytes?: number | null
  actualPromptCount?: number | null
  actualTempBytes?: number | null
  admissionState?: ReviewServingRebuildChunkAdmissionState
  budgetJson?: unknown
  diagnosticsJson?: unknown
  durationMs?: number | null
  estimatedInputRows?: number | null
  estimatedOutputBytes?: number | null
  estimatedOutputRows?: number | null
  estimatedPayloadBytes?: number | null
  estimatedPromptCount?: number | null
  estimatedTempBytes?: number | null
  maxInputRows?: number | null
  maxOutputBytes?: number | null
  maxOutputRows?: number | null
  maxPayloadBytes?: number | null
  maxPromptCount?: number | null
  maxTempBytes?: number | null
  oomCategory?: string | null
  overBudgetReason?: string | null
  parentChunkId?: string | null
  retryAfter?: Date | string | null
  retryCount?: number
  snapshotCount?: number
  snapshotId?: string | null
  splitDepth?: number
  workloadClass?: string | null
}

export type ReviewServingRebuildChunkIdentity = {
  chunkEndKey: string
  chunkStartKey: string
  inputDigest: string | null
  inputWatermark: number
  outputBaseGeneration: number
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  requestId?: string | null
}

export type ReviewServingRebuildChunkManifest = ReviewServingRebuildChunkIdentity
  & Required<Pick<ReviewServingRebuildChunkIdentity, 'requestId'>>
  & ReviewServingRebuildChunkBudgetFields & {
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

export type ReviewServingRebuildChunkManifestInput = ReviewServingRebuildChunkIdentity
  & ReviewServingRebuildChunkBudgetFields & {checksum?: string | null; status?: ReviewServingRebuildChunkStatus}

export type ReviewServingRebuildChunkValidationResult = {
  actualChecksum: string
  actualCount?: number
  expectedChecksum: string
  expectedCount?: number
}

type ReviewServingRebuildChunkManifestRow = {
  actualInputRows: number | null
  actualOutputBytes: number | null
  actualOutputRows: number | null
  actualPayloadBytes: number | null
  actualPromptCount: number | null
  actualTempBytes: number | null
  admissionState: ReviewServingRebuildChunkAdmissionState
  budgetJson: unknown
  checksum: string | null
  chunkEndKey: string
  chunkId: string
  chunkStartKey: string
  completedAt: string | null
  createdAt: string
  diagnosticsJson: unknown
  durationMs: number | null
  estimatedInputRows: number | null
  estimatedOutputBytes: number | null
  estimatedOutputRows: number | null
  estimatedPayloadBytes: number | null
  estimatedPromptCount: number | null
  estimatedTempBytes: number | null
  inputDigest: string | null
  inputWatermark: number
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  maxInputRows: number | null
  maxOutputBytes: number | null
  maxOutputRows: number | null
  maxPayloadBytes: number | null
  maxPromptCount: number | null
  maxTempBytes: number | null
  oomCategory: string | null
  outputBaseGeneration: number
  overBudgetReason: string | null
  parentChunkId: string | null
  projectId: string | null
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  requestId: string | null
  retryAfter: string | null
  retryCount: number
  snapshotCount: number
  snapshotId: string | null
  splitDepth: number
  startedAt: string | null
  status: ReviewServingRebuildChunkStatus
  updatedAt: string
  workloadClass: string | null
}

type ReviewServingRebuildRequestRetryPolicyRow = {retryPolicyJson: unknown}

type ReviewServingRebuildChunkRetryPolicy = {
  maxAttempts: number
  retryAfterMs: number
  terminalState: Extract<ReviewServingRebuildChunkStatus, 'blocked_over_budget' | 'quarantined'>
}

const defaultReviewServingRebuildChunkRetryPolicy = {
  maxAttempts: 3,
  retryAfterMs: 60_000,
  terminalState: 'quarantined',
} as const satisfies ReviewServingRebuildChunkRetryPolicy

const getReviewServingChunkManifestDatabase = () => {
  return getAppDatabaseService() as ReviewServingChunkManifestRepositoryDatabase
}

const getReviewServingChunkTimestampLiteral = (value: Date | string) => {
  return value instanceof Date ? getSqlLiteral(value) : `TIMESTAMPTZ ${getSqlLiteral(value)}`
}

const getNullableReviewServingChunkTimestampLiteral = (value: Date | string | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : getReviewServingChunkTimestampLiteral(value)
}

const getOptionalNumberLiteral = (value: number | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : getSqlLiteral(Math.trunc(value))
}

const getOptionalRowNumber = (value: number | string | null | undefined) => {
  return value === null || value === undefined ? null : Number(value)
}

const getJsonSqlLiteral = (value: unknown) => {
  return getSqlLiteral(getStableReviewServingJson(value ?? {}))
}

const getChunkRequestId = (input: ReviewServingRebuildChunkIdentity) => {
  return input.requestId ?? null
}

const getReviewServingRebuildChunkHashIdentity = (input: ReviewServingRebuildChunkIdentity) => {
  const identity = {
    chunkEndKey: input.chunkEndKey,
    chunkStartKey: input.chunkStartKey,
    inputDigest: input.inputDigest,
    inputWatermark: input.inputWatermark,
    outputBaseGeneration: input.outputBaseGeneration,
    projectId: input.projectId,
    projectionComponent: input.projectionComponent,
    projectionIdentity: input.projectionIdentity,
  }
  const requestId = getChunkRequestId(input)

  return requestId === null ? identity : {...identity, requestId}
}

export const getReviewServingRebuildChunkId = (input: ReviewServingRebuildChunkIdentity) => {
  return `chunk:${createHash('sha256')
    .update(getStableReviewServingJson(getReviewServingRebuildChunkHashIdentity(input)))
    .digest('hex')
    .slice(0, 32)}`
}

const getReviewServingRebuildChunkManifestFromRow = (
  row: ReviewServingRebuildChunkManifestRow,
): ReviewServingRebuildChunkManifest => {
  return {
    actualInputRows: getOptionalRowNumber(row.actualInputRows),
    actualOutputBytes: getOptionalRowNumber(row.actualOutputBytes),
    actualOutputRows: getOptionalRowNumber(row.actualOutputRows),
    actualPayloadBytes: getOptionalRowNumber(row.actualPayloadBytes),
    actualPromptCount: getOptionalRowNumber(row.actualPromptCount),
    actualTempBytes: getOptionalRowNumber(row.actualTempBytes),
    admissionState: row.admissionState ?? 'admitted',
    budgetJson: row.budgetJson ?? {},
    checksum: row.checksum,
    chunkEndKey: row.chunkEndKey,
    chunkId: row.chunkId,
    chunkStartKey: row.chunkStartKey,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    diagnosticsJson: row.diagnosticsJson ?? {},
    durationMs: getOptionalRowNumber(row.durationMs),
    estimatedInputRows: getOptionalRowNumber(row.estimatedInputRows),
    estimatedOutputBytes: getOptionalRowNumber(row.estimatedOutputBytes),
    estimatedOutputRows: getOptionalRowNumber(row.estimatedOutputRows),
    estimatedPayloadBytes: getOptionalRowNumber(row.estimatedPayloadBytes),
    estimatedPromptCount: getOptionalRowNumber(row.estimatedPromptCount),
    estimatedTempBytes: getOptionalRowNumber(row.estimatedTempBytes),
    inputDigest: row.inputDigest,
    inputWatermark: Number(row.inputWatermark),
    lastError: row.lastError,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseOwner: row.leaseOwner,
    maxInputRows: getOptionalRowNumber(row.maxInputRows),
    maxOutputBytes: getOptionalRowNumber(row.maxOutputBytes),
    maxOutputRows: getOptionalRowNumber(row.maxOutputRows),
    maxPayloadBytes: getOptionalRowNumber(row.maxPayloadBytes),
    maxPromptCount: getOptionalRowNumber(row.maxPromptCount),
    maxTempBytes: getOptionalRowNumber(row.maxTempBytes),
    oomCategory: row.oomCategory,
    outputBaseGeneration: Number(row.outputBaseGeneration),
    overBudgetReason: row.overBudgetReason,
    parentChunkId: row.parentChunkId,
    projectId: row.projectId,
    projectionComponent: row.projectionComponent,
    projectionIdentity: row.projectionIdentity,
    requestId: row.requestId,
    retryAfter: row.retryAfter,
    retryCount: Number(row.retryCount ?? 0),
    snapshotCount: Number(row.snapshotCount ?? 1),
    snapshotId: row.snapshotId,
    splitDepth: Number(row.splitDepth),
    startedAt: row.startedAt,
    status: row.status,
    updatedAt: row.updatedAt,
    workloadClass: row.workloadClass,
  }
}

const getReviewServingRebuildChunkSelect = (input: {tableAlias?: string} = {}) => {
  const source = input.tableAlias ?? 'app.review_rebuild_chunk_manifest'
  const from = input.tableAlias
    ? `FROM app.review_rebuild_chunk_manifest AS ${input.tableAlias}`
    : 'FROM app.review_rebuild_chunk_manifest'

  return `
    SELECT
      ${source}.chunk_id AS chunkId,
      ${source}.request_id AS requestId,
      ${source}.project_id AS projectId,
      ${source}.projection_component AS projectionComponent,
      ${source}.projection_identity AS projectionIdentity,
      ${source}.input_digest AS inputDigest,
      ${source}.input_watermark AS inputWatermark,
      ${source}.chunk_start_key AS chunkStartKey,
      ${source}.chunk_end_key AS chunkEndKey,
      ${source}.output_base_generation AS outputBaseGeneration,
      ${source}.status,
      ${source}.parent_chunk_id AS parentChunkId,
      ${source}.split_depth AS splitDepth,
      ${source}.snapshot_id AS snapshotId,
      ${source}.snapshot_count AS snapshotCount,
      ${source}.retry_count AS retryCount,
      ${source}.retry_after AS retryAfter,
      ${source}.oom_category AS oomCategory,
      ${source}.over_budget_reason AS overBudgetReason,
      ${source}.estimated_input_rows AS estimatedInputRows,
      ${source}.max_input_rows AS maxInputRows,
      ${source}.actual_input_rows AS actualInputRows,
      ${source}.estimated_output_rows AS estimatedOutputRows,
      ${source}.max_output_rows AS maxOutputRows,
      ${source}.actual_output_rows AS actualOutputRows,
      ${source}.estimated_output_bytes AS estimatedOutputBytes,
      ${source}.max_output_bytes AS maxOutputBytes,
      ${source}.actual_output_bytes AS actualOutputBytes,
      ${source}.estimated_payload_bytes AS estimatedPayloadBytes,
      ${source}.max_payload_bytes AS maxPayloadBytes,
      ${source}.actual_payload_bytes AS actualPayloadBytes,
      ${source}.estimated_prompt_count AS estimatedPromptCount,
      ${source}.max_prompt_count AS maxPromptCount,
      ${source}.actual_prompt_count AS actualPromptCount,
      ${source}.estimated_temp_bytes AS estimatedTempBytes,
      ${source}.max_temp_bytes AS maxTempBytes,
      ${source}.actual_temp_bytes AS actualTempBytes,
      ${source}.duration_ms AS durationMs,
      ${source}.workload_class AS workloadClass,
      ${source}.admission_state AS admissionState,
      ${source}.budget_json AS budgetJson,
      ${source}.diagnostics_json AS diagnosticsJson,
      ${source}.checksum,
      ${source}.lease_owner AS leaseOwner,
      ${source}.lease_expires_at AS leaseExpiresAt,
      ${source}.last_error AS lastError,
      ${source}.started_at AS startedAt,
      ${source}.completed_at AS completedAt,
      ${source}.created_at AS createdAt,
      ${source}.updated_at AS updatedAt
    ${from}
  `
}

const getReviewServingRebuildChunkIdentityPredicate = (input: ReviewServingRebuildChunkIdentity) => {
  return `
    project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
    AND request_id IS NOT DISTINCT FROM ${getSqlLiteral(getChunkRequestId(input))}
    AND projection_component = ${getSqlLiteral(input.projectionComponent)}
    AND projection_identity = ${getSqlLiteral(input.projectionIdentity)}
    AND input_digest IS NOT DISTINCT FROM ${getSqlLiteral(input.inputDigest)}
    AND input_watermark = ${getSqlLiteral(input.inputWatermark)}
    AND chunk_start_key = ${getSqlLiteral(input.chunkStartKey)}
    AND chunk_end_key = ${getSqlLiteral(input.chunkEndKey)}
    AND output_base_generation = ${getSqlLiteral(input.outputBaseGeneration)}
  `
}

const getReviewServingRebuildChunkClaimPredicate = (input: {now: Date | string}, tableAlias?: string) => {
  const source = tableAlias ? `${tableAlias}.` : ''

  return `
    ${source}admission_state = 'admitted'
    AND (
      ${source}status = 'pending'
      OR (
        ${source}status = 'failed'
        AND COALESCE(${source}retry_count, 0) < CASE
          WHEN ${source}request_id IS NULL THEN ${getSqlLiteral(defaultReviewServingRebuildChunkRetryPolicy.maxAttempts)}
          ELSE COALESCE((
            SELECT GREATEST(
              1,
              TRY_CAST(json_extract_string(policy.retry_policy_json, '$.maxAttempts') AS INTEGER)
            )
            FROM app.review_rebuild_request policy
            WHERE policy.request_id = ${source}request_id
            LIMIT 1
          ), ${getSqlLiteral(defaultReviewServingRebuildChunkRetryPolicy.maxAttempts)})
        END
        AND (
          ${source}retry_after IS NULL
          OR ${source}retry_after <= ${getReviewServingChunkTimestampLiteral(input.now)}
        )
      )
      OR (
        ${source}status = 'running'
        AND ${source}lease_expires_at <= ${getReviewServingChunkTimestampLiteral(input.now)}
      )
    )
    AND (
      ${source}request_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM app.review_rebuild_request request
        WHERE request.request_id = ${source}request_id
          AND request.status IN ('admitted', 'running')
          AND request.admission_state = 'admitted'
          AND (
            request.retry_after IS NULL
            OR request.retry_after <= ${getReviewServingChunkTimestampLiteral(input.now)}
          )
      )
    )
  `
}

const getReviewServingRebuildChunkProjectPredicate = (input: {projectId?: string | null}, tableAlias?: string) => {
  const source = tableAlias ? `${tableAlias}.` : ''

  return input.projectId === undefined
    ? ''
    : `AND ${source}project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}`
}

const getReviewServingRebuildChunkClaimWhere = (
  input: {now: Date | string; projectId?: string | null},
  tableAlias?: string,
) => {
  return `
    (${getReviewServingRebuildChunkClaimPredicate(input, tableAlias)})
    ${getReviewServingRebuildChunkProjectPredicate(input, tableAlias)}
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

export const getNextClaimableReviewServingRebuildChunk = async (
  input: {now: Date | string; projectId?: string | null},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  const rows = await database.queryJson<ReviewServingRebuildChunkManifestRow>(`
    WITH
      claimable_min_updated AS (
        SELECT MIN(candidate.updated_at) AS updated_at
        FROM app.review_rebuild_chunk_manifest AS candidate
        WHERE ${getReviewServingRebuildChunkClaimWhere(input, 'candidate')}
      ),
      claimable_min_watermark AS (
        SELECT MIN(candidate.input_watermark) AS input_watermark
        FROM app.review_rebuild_chunk_manifest AS candidate
        JOIN claimable_min_updated ON candidate.updated_at = claimable_min_updated.updated_at
        WHERE ${getReviewServingRebuildChunkClaimWhere(input, 'candidate')}
      ),
      claimable_min_start_key AS (
        SELECT MIN(candidate.chunk_start_key) AS chunk_start_key
        FROM app.review_rebuild_chunk_manifest AS candidate
        JOIN claimable_min_updated ON candidate.updated_at = claimable_min_updated.updated_at
        JOIN claimable_min_watermark ON candidate.input_watermark = claimable_min_watermark.input_watermark
        WHERE ${getReviewServingRebuildChunkClaimWhere(input, 'candidate')}
      ),
      claimable_chunk AS (
        SELECT MIN(candidate.chunk_id) AS chunk_id
        FROM app.review_rebuild_chunk_manifest AS candidate
        JOIN claimable_min_updated ON candidate.updated_at = claimable_min_updated.updated_at
        JOIN claimable_min_watermark ON candidate.input_watermark = claimable_min_watermark.input_watermark
        JOIN claimable_min_start_key ON candidate.chunk_start_key = claimable_min_start_key.chunk_start_key
        WHERE ${getReviewServingRebuildChunkClaimWhere(input, 'candidate')}
      )
    ${getReviewServingRebuildChunkSelect({tableAlias: 'manifest'})}
    JOIN claimable_chunk ON manifest.chunk_id = claimable_chunk.chunk_id
    WHERE claimable_chunk.chunk_id IS NOT NULL
    LIMIT 1
  `)
  const row = rows[0]

  return row === undefined
    ? null
    : {
        checksum: row.checksum,
        chunkEndKey: row.chunkEndKey,
        chunkStartKey: row.chunkStartKey,
        inputDigest: row.inputDigest,
        inputWatermark: Number(row.inputWatermark),
        outputBaseGeneration: Number(row.outputBaseGeneration),
        projectId: row.projectId,
        projectionComponent: row.projectionComponent,
        projectionIdentity: row.projectionIdentity,
        requestId: row.requestId ?? null,
      }
}

export const upsertReviewServingRebuildChunkManifests = async (
  inputs: readonly ReviewServingRebuildChunkManifestInput[],
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  await Promise.all(
    inputs.map(async (input) => {
      const chunkId = getReviewServingRebuildChunkId(input)
      const nowSql = getSqlLiteral(new Date())

      await database.run(`
        INSERT INTO app.review_rebuild_chunk_manifest (
          chunk_id,
          request_id,
          project_id,
          projection_component,
          projection_identity,
          input_digest,
          input_watermark,
          chunk_start_key,
          chunk_end_key,
          output_base_generation,
          status,
          parent_chunk_id,
          split_depth,
          snapshot_id,
          snapshot_count,
          retry_count,
          retry_after,
          oom_category,
          over_budget_reason,
          estimated_input_rows,
          max_input_rows,
          actual_input_rows,
          estimated_output_rows,
          max_output_rows,
          actual_output_rows,
          estimated_output_bytes,
          max_output_bytes,
          actual_output_bytes,
          estimated_payload_bytes,
          max_payload_bytes,
          actual_payload_bytes,
          estimated_prompt_count,
          max_prompt_count,
          actual_prompt_count,
          estimated_temp_bytes,
          max_temp_bytes,
          actual_temp_bytes,
          duration_ms,
          workload_class,
          admission_state,
          budget_json,
          diagnostics_json,
          checksum,
          updated_at
        ) VALUES (
          ${getSqlLiteral(chunkId)},
          ${getSqlLiteral(getChunkRequestId(input))},
          ${getSqlLiteral(input.projectId)},
          ${getSqlLiteral(input.projectionComponent)},
          ${getSqlLiteral(input.projectionIdentity)},
          ${getSqlLiteral(input.inputDigest)},
          ${getSqlLiteral(input.inputWatermark)},
          ${getSqlLiteral(input.chunkStartKey)},
          ${getSqlLiteral(input.chunkEndKey)},
          ${getSqlLiteral(input.outputBaseGeneration)},
          ${getSqlLiteral(input.status ?? 'pending')},
          ${getSqlLiteral(input.parentChunkId ?? null)},
          ${getSqlLiteral(input.splitDepth ?? 0)},
          ${getSqlLiteral(input.snapshotId ?? null)},
          ${getSqlLiteral(input.snapshotCount ?? 1)},
          ${getSqlLiteral(input.retryCount ?? 0)},
          ${getNullableReviewServingChunkTimestampLiteral(input.retryAfter)},
          ${getSqlLiteral(input.oomCategory ?? null)},
          ${getSqlLiteral(input.overBudgetReason ?? null)},
          ${getOptionalNumberLiteral(input.estimatedInputRows)},
          ${getOptionalNumberLiteral(input.maxInputRows)},
          ${getOptionalNumberLiteral(input.actualInputRows)},
          ${getOptionalNumberLiteral(input.estimatedOutputRows)},
          ${getOptionalNumberLiteral(input.maxOutputRows)},
          ${getOptionalNumberLiteral(input.actualOutputRows)},
          ${getOptionalNumberLiteral(input.estimatedOutputBytes)},
          ${getOptionalNumberLiteral(input.maxOutputBytes)},
          ${getOptionalNumberLiteral(input.actualOutputBytes)},
          ${getOptionalNumberLiteral(input.estimatedPayloadBytes)},
          ${getOptionalNumberLiteral(input.maxPayloadBytes)},
          ${getOptionalNumberLiteral(input.actualPayloadBytes)},
          ${getOptionalNumberLiteral(input.estimatedPromptCount)},
          ${getOptionalNumberLiteral(input.maxPromptCount)},
          ${getOptionalNumberLiteral(input.actualPromptCount)},
          ${getOptionalNumberLiteral(input.estimatedTempBytes)},
          ${getOptionalNumberLiteral(input.maxTempBytes)},
          ${getOptionalNumberLiteral(input.actualTempBytes)},
          ${getOptionalNumberLiteral(input.durationMs)},
          ${getSqlLiteral(input.workloadClass ?? null)},
          ${getSqlLiteral(input.admissionState ?? 'admitted')},
          ${getJsonSqlLiteral(input.budgetJson)},
          ${getJsonSqlLiteral(input.diagnosticsJson)},
          ${getSqlLiteral(input.checksum ?? null)},
          ${nowSql}
        )
        ON CONFLICT(chunk_id) DO UPDATE SET
          request_id = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.request_id
            ELSE excluded.request_id
          END,
          status = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.status
            ELSE excluded.status
          END,
          admission_state = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.admission_state
            ELSE excluded.admission_state
          END,
          retry_after = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.retry_after
            ELSE excluded.retry_after
          END,
          retry_count = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.retry_count
            ELSE excluded.retry_count
          END,
          oom_category = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.oom_category
            ELSE excluded.oom_category
          END,
          over_budget_reason = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.over_budget_reason
            ELSE excluded.over_budget_reason
          END,
          budget_json = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.budget_json
            ELSE excluded.budget_json
          END,
          diagnostics_json = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.diagnostics_json
            ELSE excluded.diagnostics_json
          END,
          checksum = CASE
            WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN app.review_rebuild_chunk_manifest.checksum
            ELSE excluded.checksum
          END,
          lease_owner = CASE WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN lease_owner ELSE NULL END,
          lease_expires_at = CASE WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN lease_expires_at ELSE NULL END,
          last_error = CASE WHEN app.review_rebuild_chunk_manifest.status = 'completed' THEN last_error ELSE NULL END,
          updated_at = ${nowSql}
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
      UPDATE app.review_rebuild_chunk_manifest AS manifest
      SET
        status = 'running',
        lease_owner = ${getSqlLiteral(input.leaseOwner)},
        lease_expires_at = ${getReviewServingChunkTimestampLiteral(input.leaseExpiresAt)},
        last_error = NULL,
        started_at = COALESCE(started_at, current_timestamp),
        updated_at = current_timestamp
      WHERE manifest.chunk_id = ${getSqlLiteral(chunkId)}
        AND (${getReviewServingRebuildChunkClaimPredicate(input, 'manifest')})
    `)

    const claimed = await getReviewServingRebuildChunkManifest({chunkId}, tx)

    return claimed?.status === 'running' && claimed.leaseOwner === input.leaseOwner ? claimed : null
  })
}

const isPositiveInteger = (value: unknown) => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const getRetryPolicyNumber = (value: unknown, fallback: number) => {
  return isPositiveInteger(value) ? value : fallback
}

const getRetryPolicyTerminalState = (value: unknown): ReviewServingRebuildChunkRetryPolicy['terminalState'] => {
  return value === 'blocked_over_budget' || value === 'quarantined'
    ? value
    : defaultReviewServingRebuildChunkRetryPolicy.terminalState
}

const getRetryPolicyFromValue = (value: unknown): ReviewServingRebuildChunkRetryPolicy => {
  const policy = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

  return {
    maxAttempts: getRetryPolicyNumber(
      'maxAttempts' in policy ? policy.maxAttempts : undefined,
      defaultReviewServingRebuildChunkRetryPolicy.maxAttempts,
    ),
    retryAfterMs: getRetryPolicyNumber(
      'retryAfterMs' in policy ? policy.retryAfterMs : undefined,
      defaultReviewServingRebuildChunkRetryPolicy.retryAfterMs,
    ),
    terminalState: getRetryPolicyTerminalState('terminalState' in policy ? policy.terminalState : undefined),
  }
}

const getReviewServingRebuildChunkRetryPolicy = async (
  input: {requestId: string | null},
  database: ReviewServingChunkManifestRepositoryTransaction,
) => {
  if (input.requestId === null) {
    return defaultReviewServingRebuildChunkRetryPolicy
  }

  const [row] = await database.queryJson<ReviewServingRebuildRequestRetryPolicyRow>(`
    SELECT retry_policy_json AS retryPolicyJson
    FROM app.review_rebuild_request
    WHERE request_id = ${getSqlLiteral(input.requestId)}
    LIMIT 1
  `)

  return row === undefined
    ? defaultReviewServingRebuildChunkRetryPolicy
    : getRetryPolicyFromValue(getJsonValue(row.retryPolicyJson))
}

export const markReviewServingRebuildChunkFailed = async (
  input: {chunkId: string; error: string; leaseOwner?: string; now?: Date | string},
  database: ReviewServingChunkManifestRepositoryTransaction = getReviewServingChunkManifestDatabase(),
) => {
  const leasePredicate = input.leaseOwner ? `AND lease_owner = ${getSqlLiteral(input.leaseOwner)}` : ''
  const existing = await getReviewServingRebuildChunkManifest({chunkId: input.chunkId}, database)
  const retryPolicy = await getReviewServingRebuildChunkRetryPolicy({requestId: existing?.requestId ?? null}, database)
  const retryCount = (existing?.retryCount ?? 0) + 1
  const exhausted = retryCount >= retryPolicy.maxAttempts
  const status = exhausted ? retryPolicy.terminalState : 'failed'
  const retryAfter = exhausted
    ? null
    : new Date(new Date(input.now ?? new Date()).getTime() + retryPolicy.retryAfterMs).toISOString()

  await database.run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET
      status = ${getSqlLiteral(status)},
      admission_state = CASE
        WHEN ${getSqlLiteral(status)} = 'blocked_over_budget' THEN 'blocked_over_budget'
        ELSE admission_state
      END,
      retry_count = ${getSqlLiteral(retryCount)},
      retry_after = ${getNullableReviewServingChunkTimestampLiteral(retryAfter)},
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

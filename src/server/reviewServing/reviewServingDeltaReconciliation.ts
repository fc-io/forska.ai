import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  appendReviewServingChangeDelta,
  appendReviewServingImportRunArticleDelta,
  getReviewServingDeltaIdempotencyKey,
  type ReviewServingDeltaAppendInput,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingIdempotencyKeyInput,
  type ReviewServingImportRunArticleDeltaAppendInput,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'

export type ReviewServingOutboxReconciliationResult =
  | {outboxId: string; status: 'missing'}
  | {outboxId: string; status: 'reconciled'; sourceHighWaterMark: number}
  | {outboxId: string; reason: string; retryCount: number; status: 'quarantined' | 'retryable'}
  | {outboxId: string; status: 'skipped'; currentStatus: string}

export type ReviewServingOutboxReconciliationOptions = {maxRetries?: number; outboxId: string}

export type ReviewServingOutboxBarrier = {outboxId: string; sourceHighWaterMark: number; status: string}

export type ReviewServingProjectorWatermarkAdvanceInput = {
  importRouteId?: string | null
  projectId?: string | null
  projectionComponent: string
  projectorName: string
  sourceHighWaterMark: number
  sourcePartition: string
}

type ReviewServingSourceChangeOutboxRow = {
  idempotencyKey: string
  outboxId: string
  payloadVersion: number
  recoveryPayloadJson: unknown
  retryCount: number
  sourceHighWaterMark: number
  sourceOperation: string
  sourcePartition: string
  sourceRowId: string
  sourceTable: string
  sourceUpdatedAt: string | null
  status: string
}

type ReviewServingReviewChangeRecoveryPayload = Omit<
  ReviewServingDeltaAppendInput,
  keyof ReviewServingIdempotencyKeyInput | 'allocatedSourceHighWaterMark' | 'payloadVersion' | 'sourceUpdatedAt'
> & {deltaTable: 'review_change_delta'; sourceMutationKey: string; typedKey: ReviewServingIdentityValue}

type ReviewServingImportRunArticleRecoveryPayload = Omit<
  ReviewServingImportRunArticleDeltaAppendInput,
  keyof ReviewServingIdempotencyKeyInput | 'allocatedSourceHighWaterMark' | 'payloadVersion' | 'sourceUpdatedAt'
> & {deltaTable: 'import_run_article_delta'; sourceMutationKey: string; typedKey: ReviewServingIdentityValue}

type ReviewServingOutboxRecoveryPayload =
  | ReviewServingImportRunArticleRecoveryPayload
  | ReviewServingReviewChangeRecoveryPayload

const terminalOutboxStatuses: readonly string[] = ['operator_terminal', 'reconciled']

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const parseReviewServingRecoveryPayloadJson = (value: unknown) => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch (_error) {
    return null
  }
}

const isReviewServingSourceOperation = (value: string): value is ReviewServingSourceOperation => {
  return value === 'delete' || value === 'insert' || value === 'update' || value === 'upsert'
}

const getReviewServingOutboxRecoveryPayload = (value: unknown): ReviewServingOutboxRecoveryPayload | null => {
  const parsed = parseReviewServingRecoveryPayloadJson(value)

  if (
    !isRecord(parsed)
    || !isRecord(parsed.typedKey)
    || typeof parsed.changeKind !== 'string'
    || typeof parsed.sourceMutationKey !== 'string'
  ) {
    return null
  }

  if (parsed.deltaTable === 'review_change_delta') {
    return parsed as ReviewServingReviewChangeRecoveryPayload
  }

  return parsed.deltaTable === 'import_run_article_delta'
    ? (parsed as ReviewServingImportRunArticleRecoveryPayload)
    : null
}

const getReviewServingOutboxRow = async (tx: ReviewServingDeltaLedgerTransaction, outboxId: string) => {
  const rows = await tx.queryJson<ReviewServingSourceChangeOutboxRow>(`
    SELECT
      outbox_id AS outboxId,
      source_table AS sourceTable,
      source_row_id AS sourceRowId,
      source_operation AS sourceOperation,
      source_partition AS sourcePartition,
      source_high_water_mark AS sourceHighWaterMark,
      source_updated_at AS sourceUpdatedAt,
      idempotency_key AS idempotencyKey,
      payload_version AS payloadVersion,
      recovery_payload_json AS recoveryPayloadJson,
      status,
      retry_count AS retryCount
    FROM app.review_source_change_outbox
    WHERE outbox_id = ${getSqlLiteral(outboxId)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

const getRetryStatus = (retryCount: number, maxRetries: number) => {
  return retryCount >= maxRetries ? 'quarantined' : 'retryable'
}

const markReviewServingOutboxFailure = async (
  tx: ReviewServingDeltaLedgerTransaction,
  row: ReviewServingSourceChangeOutboxRow,
  reason: string,
  maxRetries: number,
): Promise<ReviewServingOutboxReconciliationResult> => {
  const retryCount = row.retryCount + 1
  const status = getRetryStatus(retryCount, maxRetries)

  await tx.run(`
    UPDATE app.review_source_change_outbox
    SET
      status = ${getSqlLiteral(status)},
      retry_count = ${retryCount},
      last_error = ${getSqlLiteral(reason)},
      updated_at = current_timestamp,
      quarantined_at = ${status === 'quarantined' ? 'current_timestamp' : 'NULL'}
    WHERE outbox_id = ${getSqlLiteral(row.outboxId)}
  `)

  return {outboxId: row.outboxId, reason, retryCount, status}
}

const markReviewServingOutboxReconciled = async (
  tx: ReviewServingDeltaLedgerTransaction,
  row: ReviewServingSourceChangeOutboxRow,
) => {
  await tx.run(`
    UPDATE app.review_source_change_outbox
    SET
      status = 'reconciled',
      last_error = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = current_timestamp,
      reconciled_at = current_timestamp
    WHERE outbox_id = ${getSqlLiteral(row.outboxId)}
  `)
}

const getOutboxSourceIdentity = (
  row: ReviewServingSourceChangeOutboxRow,
  payload: ReviewServingOutboxRecoveryPayload,
) => {
  return {
    sourceMutationKey: payload.sourceMutationKey,
    sourceOperation: row.sourceOperation as ReviewServingSourceOperation,
    sourcePartition: row.sourcePartition,
    sourceRowId: row.sourceRowId,
    sourceTable: row.sourceTable,
    typedKey: payload.typedKey,
  }
}

const getOutboxIdempotencyValidationError = (
  row: ReviewServingSourceChangeOutboxRow,
  payload: ReviewServingOutboxRecoveryPayload,
) => {
  const identity = getOutboxSourceIdentity(row, payload)
  const idempotencyKey = getReviewServingDeltaIdempotencyKey(identity)

  return idempotencyKey === row.idempotencyKey ? null : 'outbox recovery payload does not match idempotency key'
}

const appendRecoveredReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  row: ReviewServingSourceChangeOutboxRow,
  payload: ReviewServingOutboxRecoveryPayload,
) => {
  const sourceIdentity = getOutboxSourceIdentity(row, payload)
  const commonInput = {
    ...sourceIdentity,
    allocatedSourceHighWaterMark: row.sourceHighWaterMark,
    payloadVersion: row.payloadVersion,
    sourceUpdatedAt: row.sourceUpdatedAt,
  }

  return payload.deltaTable === 'review_change_delta'
    ? appendReviewServingChangeDelta(tx, {...commonInput, ...payload})
    : appendReviewServingImportRunArticleDelta(tx, {...commonInput, ...payload})
}

export const reconcileReviewServingDeltaOutboxRow = async (
  tx: ReviewServingDeltaLedgerTransaction,
  options: ReviewServingOutboxReconciliationOptions,
): Promise<ReviewServingOutboxReconciliationResult> => {
  const maxRetries = options.maxRetries ?? 3
  const row = await getReviewServingOutboxRow(tx, options.outboxId)

  if (!row) {
    return {outboxId: options.outboxId, status: 'missing'}
  }

  if (terminalOutboxStatuses.includes(row.status) || row.status === 'quarantined') {
    return {currentStatus: row.status, outboxId: row.outboxId, status: 'skipped'}
  }

  if (!isReviewServingSourceOperation(row.sourceOperation)) {
    return markReviewServingOutboxFailure(tx, row, `unsupported source operation: ${row.sourceOperation}`, maxRetries)
  }

  const payload = getReviewServingOutboxRecoveryPayload(row.recoveryPayloadJson)

  if (!payload) {
    return markReviewServingOutboxFailure(tx, row, 'malformed recovery payload', maxRetries)
  }

  const idempotencyError = getOutboxIdempotencyValidationError(row, payload)

  if (idempotencyError) {
    return markReviewServingOutboxFailure(tx, row, idempotencyError, maxRetries)
  }

  try {
    await appendRecoveredReviewServingDelta(tx, row, payload)
    await markReviewServingOutboxReconciled(tx, row)

    return {outboxId: row.outboxId, sourceHighWaterMark: row.sourceHighWaterMark, status: 'reconciled'}
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    return markReviewServingOutboxFailure(tx, row, reason, maxRetries)
  }
}

export const getReviewServingOutboxWatermarkBarrier = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: {sourceHighWaterMark: number; sourcePartition: string},
) => {
  const rows = await tx.queryJson<ReviewServingOutboxBarrier>(`
    SELECT
      outbox_id AS outboxId,
      source_high_water_mark AS sourceHighWaterMark,
      status
    FROM app.review_source_change_outbox
    WHERE source_partition = ${getSqlLiteral(input.sourcePartition)}
      AND source_high_water_mark <= ${input.sourceHighWaterMark}
      AND status NOT IN (${terminalOutboxStatuses.map(getSqlLiteral).join(', ')})
    ORDER BY source_high_water_mark ASC, created_at ASC, outbox_id ASC
    LIMIT 1
  `)

  return rows[0] ?? null
}

export const assertReviewServingProjectorWatermarkCanAdvance = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: {sourceHighWaterMark: number; sourcePartition: string},
) => {
  const barrier = await getReviewServingOutboxWatermarkBarrier(tx, input)

  if (barrier) {
    throw new Error(
      `review-serving watermark blocked by unreconciled outbox ${barrier.outboxId} at ${barrier.sourceHighWaterMark} (${barrier.status})`,
    )
  }
}

export const advanceReviewServingProjectorWatermark = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewServingProjectorWatermarkAdvanceInput,
) => {
  await assertReviewServingProjectorWatermarkCanAdvance(tx, input)
  await tx.run(`
    UPDATE app.review_serving_projector_watermark
    SET
      source_high_water_mark = ${input.sourceHighWaterMark},
      updated_at = current_timestamp
    WHERE projector_name = ${getSqlLiteral(input.projectorName)}
      AND project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND import_route_id IS NOT DISTINCT FROM ${getSqlLiteral(input.importRouteId)}
      AND projection_component = ${getSqlLiteral(input.projectionComponent)}
      AND source_partition = ${getSqlLiteral(input.sourcePartition)}
  `)
}

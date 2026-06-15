import {createHash} from 'node:crypto'

import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'

export type ReviewServingDeltaLedgerTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ReviewServingSourceOperation = 'delete' | 'insert' | 'update' | 'upsert'

export type ReviewServingIdempotencyKeyInput = {
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition: string
  sourceRowId: string
  sourceTable: string
  typedKey: ReviewServingIdentityValue
}

export type ReviewServingDeltaAppendInput = ReviewServingIdempotencyKeyInput & {
  articleId?: string | null
  changeKind: string
  configFieldSet?: string | null
  humanJudgmentKey?: string | null
  judgmentId?: string | null
  modelId?: string | null
  payloadJson?: ReviewServingIdentityValue
  payloadVersion: number
  projectId?: string | null
  promptId?: string | null
  sourceUpdatedAt?: Date | string | null
  tombstone?: boolean
  useAbstract?: boolean | null
  useFulltext?: boolean | null
  useFulltextNoImages?: boolean | null
  useTitle?: boolean | null
}

export type ReviewServingImportRunArticleDeltaAppendInput = ReviewServingIdempotencyKeyInput & {
  articleId?: string | null
  changeKind: string
  importRouteId?: string | null
  importRunId?: string | null
  payloadJson?: ReviewServingIdentityValue
  payloadVersion: number
  publicationYear?: number | null
  selectedRankKey?: string | null
  sourceRecordHash?: string | null
  sourceRecordKey?: string | null
  sourceUpdatedAt?: Date | string | null
  tombstone?: boolean
}

export type ReviewServingOutboxAppendInput = ReviewServingIdempotencyKeyInput & {
  payloadVersion: number
  recoveryPayloadJson?: ReviewServingIdentityValue
  sourceUpdatedAt?: Date | string | null
}

export type ReviewServingDeltaAppendResult = {
  deltaId: string
  idempotencyKey: string
  inserted: boolean
  sourceHighWaterMark: number
}

export type ReviewServingOutboxAppendResult = {
  idempotencyKey: string
  inserted: boolean
  outboxId: string
  sourceHighWaterMark: number
}

type ReviewServingDeltaTable = 'app.import_run_article_delta' | 'app.review_change_delta'

type ExistingDeltaRow = {deltaId: string; sourceHighWaterMark: number}
type ExistingOutboxRow = {outboxId: string; sourceHighWaterMark: number}
type SourceHighWaterRow = {sourceHighWaterMark: number}

const getReviewServingHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const getReviewServingTimestampLiteral = (value: Date | string | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : `${getSqlLiteral(value)}::TIMESTAMPTZ`
}

const getReviewServingJsonLiteral = (value: ReviewServingIdentityValue) => {
  return value === undefined ? 'NULL' : `${getSqlLiteral(value)}::JSON`
}

const getReviewServingPayloadValue = (value: ReviewServingIdentityValue) => {
  return value === undefined ? null : value
}

const getReviewServingIdempotencyIdentityValue = (input: ReviewServingIdempotencyKeyInput) => {
  return {
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition: input.sourcePartition,
    sourceRowId: input.sourceRowId,
    sourceTable: input.sourceTable,
    typedKey: input.typedKey,
  }
}

const getDeterministicReviewServingLedgerId = (prefix: 'delta' | 'outbox', idempotencyKey: string) => {
  return `${prefix}:${getReviewServingHash(`review-serving-${prefix}-identity`, idempotencyKey).slice(0, 32)}`
}

const getExistingReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  table: ReviewServingDeltaTable,
  idempotencyKey: string,
) => {
  const rows = await tx.queryJson<ExistingDeltaRow>(`
    SELECT
      delta_id AS deltaId,
      source_high_water_mark AS sourceHighWaterMark
    FROM ${table}
    WHERE idempotency_key = ${getSqlLiteral(idempotencyKey)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

const getExistingReviewServingOutbox = async (tx: ReviewServingDeltaLedgerTransaction, idempotencyKey: string) => {
  const rows = await tx.queryJson<ExistingOutboxRow>(`
    SELECT
      outbox_id AS outboxId,
      source_high_water_mark AS sourceHighWaterMark
    FROM app.review_source_change_outbox
    WHERE idempotency_key = ${getSqlLiteral(idempotencyKey)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

export const getReviewServingDeltaIdempotencyKey = (input: ReviewServingIdempotencyKeyInput) => {
  return `review-serving-delta:${getReviewServingHash(
    'review-serving-delta-idempotency',
    getReviewServingIdempotencyIdentityValue(input),
  )}`
}

export const allocateReviewServingSourceHighWaterMark = async (
  tx: ReviewServingDeltaLedgerTransaction,
  sourcePartition: string,
) => {
  await tx.run(`
    INSERT INTO app.review_delta_reconciliation_cursor (source_partition, source_high_water_mark)
    VALUES (${getSqlLiteral(sourcePartition)}, 0)
    ON CONFLICT(source_partition) DO NOTHING
  `)
  await tx.run(`
    UPDATE app.review_delta_reconciliation_cursor
    SET
      source_high_water_mark = source_high_water_mark + 1,
      updated_at = current_timestamp
    WHERE source_partition = ${getSqlLiteral(sourcePartition)}
  `)
  const rows = await tx.queryJson<SourceHighWaterRow>(`
    SELECT source_high_water_mark AS sourceHighWaterMark
    FROM app.review_delta_reconciliation_cursor
    WHERE source_partition = ${getSqlLiteral(sourcePartition)}
    LIMIT 1
  `)
  const sourceHighWaterMark = rows[0]?.sourceHighWaterMark ?? null

  if (sourceHighWaterMark === null) {
    throw new Error(`failed to allocate review serving source high-water mark for ${sourcePartition}`)
  }

  return sourceHighWaterMark
}

export const appendReviewServingChangeDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewServingDeltaAppendInput,
): Promise<ReviewServingDeltaAppendResult> => {
  const idempotencyKey = getReviewServingDeltaIdempotencyKey(input)
  const existing = await getExistingReviewServingDelta(tx, 'app.review_change_delta', idempotencyKey)

  if (existing) {
    return {
      deltaId: existing.deltaId,
      idempotencyKey,
      inserted: false,
      sourceHighWaterMark: existing.sourceHighWaterMark,
    }
  }

  const deltaId = getDeterministicReviewServingLedgerId('delta', idempotencyKey)
  const sourceHighWaterMark = await allocateReviewServingSourceHighWaterMark(tx, input.sourcePartition)

  await tx.run(`
    INSERT INTO app.review_change_delta (
      delta_id,
      change_kind,
      source_table,
      source_row_id,
      source_operation,
      source_partition,
      source_high_water_mark,
      source_updated_at,
      idempotency_key,
      payload_version,
      project_id,
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      judgment_id,
      human_judgment_key,
      config_field_set,
      tombstone,
      payload_json
    ) VALUES (
      ${getSqlLiteral(deltaId)},
      ${getSqlLiteral(input.changeKind)},
      ${getSqlLiteral(input.sourceTable)},
      ${getSqlLiteral(input.sourceRowId)},
      ${getSqlLiteral(input.sourceOperation)},
      ${getSqlLiteral(input.sourcePartition)},
      ${sourceHighWaterMark},
      ${getReviewServingTimestampLiteral(input.sourceUpdatedAt)},
      ${getSqlLiteral(idempotencyKey)},
      ${input.payloadVersion},
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.articleId)},
      ${getSqlLiteral(input.promptId)},
      ${getSqlLiteral(input.modelId)},
      ${getSqlLiteral(input.useTitle)},
      ${getSqlLiteral(input.useAbstract)},
      ${getSqlLiteral(input.useFulltext)},
      ${getSqlLiteral(input.useFulltextNoImages)},
      ${getSqlLiteral(input.judgmentId)},
      ${getSqlLiteral(input.humanJudgmentKey)},
      ${getSqlLiteral(input.configFieldSet)},
      ${getSqlLiteral(input.tombstone ?? false)},
      ${getReviewServingJsonLiteral(getReviewServingPayloadValue(input.payloadJson))}
    )
  `)

  return {deltaId, idempotencyKey, inserted: true, sourceHighWaterMark}
}

export const appendReviewServingImportRunArticleDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewServingImportRunArticleDeltaAppendInput,
): Promise<ReviewServingDeltaAppendResult> => {
  const idempotencyKey = getReviewServingDeltaIdempotencyKey(input)
  const existing = await getExistingReviewServingDelta(tx, 'app.import_run_article_delta', idempotencyKey)

  if (existing) {
    return {
      deltaId: existing.deltaId,
      idempotencyKey,
      inserted: false,
      sourceHighWaterMark: existing.sourceHighWaterMark,
    }
  }

  const deltaId = getDeterministicReviewServingLedgerId('delta', idempotencyKey)
  const sourceHighWaterMark = await allocateReviewServingSourceHighWaterMark(tx, input.sourcePartition)

  await tx.run(`
    INSERT INTO app.import_run_article_delta (
      delta_id,
      change_kind,
      source_table,
      source_row_id,
      source_operation,
      source_partition,
      source_high_water_mark,
      source_updated_at,
      idempotency_key,
      payload_version,
      import_run_id,
      import_route_id,
      article_id,
      source_record_key,
      source_record_hash,
      selected_rank_key,
      publication_year,
      tombstone,
      payload_json
    ) VALUES (
      ${getSqlLiteral(deltaId)},
      ${getSqlLiteral(input.changeKind)},
      ${getSqlLiteral(input.sourceTable)},
      ${getSqlLiteral(input.sourceRowId)},
      ${getSqlLiteral(input.sourceOperation)},
      ${getSqlLiteral(input.sourcePartition)},
      ${sourceHighWaterMark},
      ${getReviewServingTimestampLiteral(input.sourceUpdatedAt)},
      ${getSqlLiteral(idempotencyKey)},
      ${input.payloadVersion},
      ${getSqlLiteral(input.importRunId)},
      ${getSqlLiteral(input.importRouteId)},
      ${getSqlLiteral(input.articleId)},
      ${getSqlLiteral(input.sourceRecordKey)},
      ${getSqlLiteral(input.sourceRecordHash)},
      ${getSqlLiteral(input.selectedRankKey)},
      ${getSqlLiteral(input.publicationYear)},
      ${getSqlLiteral(input.tombstone ?? false)},
      ${getReviewServingJsonLiteral(getReviewServingPayloadValue(input.payloadJson))}
    )
  `)

  return {deltaId, idempotencyKey, inserted: true, sourceHighWaterMark}
}

export const appendReviewServingSourceChangeOutbox = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewServingOutboxAppendInput,
): Promise<ReviewServingOutboxAppendResult> => {
  const idempotencyKey = getReviewServingDeltaIdempotencyKey(input)
  const existing = await getExistingReviewServingOutbox(tx, idempotencyKey)

  if (existing) {
    return {
      idempotencyKey,
      inserted: false,
      outboxId: existing.outboxId,
      sourceHighWaterMark: existing.sourceHighWaterMark,
    }
  }

  const outboxId = getDeterministicReviewServingLedgerId('outbox', idempotencyKey)
  const sourceHighWaterMark = await allocateReviewServingSourceHighWaterMark(tx, input.sourcePartition)

  await tx.run(`
    INSERT INTO app.review_source_change_outbox (
      outbox_id,
      source_table,
      source_row_id,
      source_operation,
      source_partition,
      source_high_water_mark,
      source_updated_at,
      idempotency_key,
      payload_version,
      recovery_payload_json
    ) VALUES (
      ${getSqlLiteral(outboxId)},
      ${getSqlLiteral(input.sourceTable)},
      ${getSqlLiteral(input.sourceRowId)},
      ${getSqlLiteral(input.sourceOperation)},
      ${getSqlLiteral(input.sourcePartition)},
      ${sourceHighWaterMark},
      ${getReviewServingTimestampLiteral(input.sourceUpdatedAt)},
      ${getSqlLiteral(idempotencyKey)},
      ${input.payloadVersion},
      ${getReviewServingJsonLiteral(getReviewServingPayloadValue(input.recoveryPayloadJson))}
    )
  `)

  return {idempotencyKey, inserted: true, outboxId, sourceHighWaterMark}
}

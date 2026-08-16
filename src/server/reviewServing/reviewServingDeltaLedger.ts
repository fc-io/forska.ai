import {createHash, randomUUID} from 'node:crypto'

import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {type ReviewServingChangeKind} from './reviewServingContracts.ts'
import {getReviewServingInvalidationRuleOrNull} from './reviewServingInvalidationRegistry.ts'

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

export type ReviewServingImportRunArticleChangeKind = Extract<
  ReviewServingChangeKind,
  'importRoute.article.added' | 'importRoute.article.rankFields.updated' | 'importRoute.article.removed'
>

export type ReviewServingDeltaAppendInput = ReviewServingIdempotencyKeyInput & {
  allocatedSourceHighWaterMark?: number
  articleId?: string | null
  changeKind: ReviewServingChangeKind
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
  allocatedSourceHighWaterMark?: number
  articleId?: string | null
  changeKind: ReviewServingImportRunArticleChangeKind
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

type BulkExistingDeltaRow = ExistingDeltaRow & {idempotencyKey: string}
type BulkSourceHighWaterRow = SourceHighWaterRow & {sourcePartition: string}
type BulkSourceHighWaterAllocation = {incrementCount: number; sourcePartition: string}
type BulkDeltaAppendInput = ReviewServingDeltaAppendInput | ReviewServingImportRunArticleDeltaAppendInput
type PreparedBulkDelta<TInput extends BulkDeltaAppendInput> = {
  changeKind: ReviewServingChangeKind
  deltaId: string
  idempotencyKey: string
  input: TInput
  inputIndex: number
}
type ResolvedBulkDelta<TInput extends BulkDeltaAppendInput> = PreparedBulkDelta<TInput> & {
  advanceCursor: boolean
  sourceHighWaterMark: number
}
type BulkDeltaTarget<TInput extends BulkDeltaAppendInput> = {
  getRowValuesSql: (row: ResolvedBulkDelta<TInput>) => string
  getTargetInsertSql: (tableName: string) => string
  table: ReviewServingDeltaTable
}

const reviewServingBulkValuesChunkSize = 500
const reviewServingBulkTempColumns = [
  'input_index',
  'delta_id',
  'change_kind',
  'source_table',
  'source_row_id',
  'source_operation',
  'source_partition',
  'source_high_water_mark',
  'source_updated_at',
  'idempotency_key',
  'payload_version',
  'tombstone',
  'payload_json',
  'advance_cursor',
  'project_id',
  'article_id',
  'prompt_id',
  'model_id',
  'use_title',
  'use_abstract',
  'use_fulltext',
  'use_fulltext_no_images',
  'judgment_id',
  'human_judgment_key',
  'config_field_set',
  'import_run_id',
  'import_route_id',
  'source_record_key',
  'source_record_hash',
  'selected_rank_key',
  'publication_year',
] as const

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

const getReviewServingDeltaTombstone = (input: {changeKind: string; sourceOperation: string; tombstone?: boolean}) => {
  return (
    input.tombstone
    ?? (input.sourceOperation === 'delete'
      || input.changeKind.endsWith('.deleted')
      || input.changeKind.endsWith('.removed'))
  )
}

const validateReviewServingChangeKind = (changeKind: string) => {
  const rule = getReviewServingInvalidationRuleOrNull(changeKind)

  if (!rule) {
    throw new Error(`unknown review-serving change kind: ${changeKind}`)
  }

  return rule.changeKind
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

const getReviewServingBulkValueChunks = <TValue>(values: readonly TValue[]) => {
  return Array.from({length: Math.ceil(values.length / reviewServingBulkValuesChunkSize)}, (_, index) => {
    const start = index * reviewServingBulkValuesChunkSize

    return values.slice(start, start + reviewServingBulkValuesChunkSize)
  })
}

const getBulkSourceHighWaterMarkNumber = (value: number) => {
  const sourceHighWaterMark = Number(value)

  if (!Number.isSafeInteger(sourceHighWaterMark)) {
    throw new Error(`invalid review-serving source high-water mark: ${String(value)}`)
  }

  return sourceHighWaterMark
}

const getPreparedBulkDeltas = <TInput extends BulkDeltaAppendInput>(inputs: readonly TInput[]) => {
  return inputs.map((input, inputIndex): PreparedBulkDelta<TInput> => {
    const idempotencyKey = getReviewServingDeltaIdempotencyKey(input)

    return {
      changeKind: validateReviewServingChangeKind(input.changeKind),
      deltaId: getDeterministicReviewServingLedgerId('delta', idempotencyKey),
      idempotencyKey,
      input,
      inputIndex,
    }
  })
}

const getUniquePreparedBulkDeltas = <TInput extends BulkDeltaAppendInput>(
  prepared: readonly PreparedBulkDelta<TInput>[],
) => {
  const seen = new Set<string>()

  return prepared.filter((row) => {
    const isFirst = !seen.has(row.idempotencyKey)
    seen.add(row.idempotencyKey)

    return isFirst
  })
}

const getExistingBulkDeltas = async <TInput extends BulkDeltaAppendInput>({
  prepared,
  table,
  tx,
}: {
  prepared: readonly PreparedBulkDelta<TInput>[]
  table: ReviewServingDeltaTable
  tx: ReviewServingDeltaLedgerTransaction
}) => {
  const existingByIdempotencyKey = new Map<string, ExistingDeltaRow>()

  await getReviewServingBulkValueChunks(prepared).reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    const rows = await tx.queryJson<BulkExistingDeltaRow>(`
      SELECT
        existing.delta_id AS deltaId,
        existing.idempotency_key AS idempotencyKey,
        existing.source_high_water_mark AS sourceHighWaterMark
      FROM (VALUES ${chunk
        .map((row) => {
          return `(${row.inputIndex}, ${getSqlLiteral(row.idempotencyKey)})`
        })
        .join(', ')}) AS candidates(input_index, idempotency_key)
      INNER JOIN ${table} existing
        ON existing.idempotency_key = candidates.idempotency_key
      ORDER BY candidates.input_index ASC
    `)

    rows.reduce((mapped, row) => {
      mapped.set(row.idempotencyKey, {
        deltaId: row.deltaId,
        sourceHighWaterMark: getBulkSourceHighWaterMarkNumber(row.sourceHighWaterMark),
      })

      return mapped
    }, existingByIdempotencyKey)
  }, Promise.resolve())

  return existingByIdempotencyKey
}

const getBulkSourceHighWaterAllocations = (prepared: readonly PreparedBulkDelta<BulkDeltaAppendInput>[]) => {
  return prepared.reduce((allocations, row) => {
    if (row.input.allocatedSourceHighWaterMark !== null && row.input.allocatedSourceHighWaterMark !== undefined) {
      return allocations
    }

    allocations.set(row.input.sourcePartition, (allocations.get(row.input.sourcePartition) ?? 0) + 1)

    return allocations
  }, new Map<string, number>())
}

const getBulkSourceHighWaterAllocationValuesSql = (
  allocations: readonly BulkSourceHighWaterAllocation[],
  includeIncrementCount: boolean,
) => {
  return allocations
    .map((allocation) => {
      return includeIncrementCount
        ? `(${getSqlLiteral(allocation.sourcePartition)}, ${allocation.incrementCount})`
        : `(${getSqlLiteral(allocation.sourcePartition)})`
    })
    .join(', ')
}

const allocateBulkSourceHighWaterMarkRanges = async ({
  allocationCountsByPartition,
  tx,
}: {
  allocationCountsByPartition: ReadonlyMap<string, number>
  tx: ReviewServingDeltaLedgerTransaction
}) => {
  const sourceHighWaterByPartition = new Map<string, number>()
  const allocations = [...allocationCountsByPartition.entries()].map(([sourcePartition, incrementCount]) => {
    return {incrementCount, sourcePartition}
  })

  if (allocations.length === 0) {
    return sourceHighWaterByPartition
  }

  await getReviewServingBulkValueChunks(allocations).reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    const partitionValuesSql = getBulkSourceHighWaterAllocationValuesSql(chunk, false)
    const allocationValuesSql = getBulkSourceHighWaterAllocationValuesSql(chunk, true)

    await tx.run(`
      INSERT INTO app.review_delta_reconciliation_cursor (source_partition, source_high_water_mark)
      SELECT candidates.source_partition, 0
      FROM (VALUES ${partitionValuesSql}) AS candidates(source_partition)
      WHERE NOT EXISTS (
        SELECT 1
        FROM app.review_delta_reconciliation_cursor cursor
        WHERE cursor.source_partition = candidates.source_partition
      )
    `)
    await tx.run(`
      UPDATE app.review_delta_reconciliation_cursor AS cursor
      SET
        source_high_water_mark = cursor.source_high_water_mark + allocations.increment_count,
        updated_at = current_timestamp
      FROM (VALUES ${allocationValuesSql}) AS allocations(source_partition, increment_count)
      WHERE cursor.source_partition = allocations.source_partition
    `)
    const rows = await tx.queryJson<BulkSourceHighWaterRow>(`
      SELECT
        candidates.source_partition AS sourcePartition,
        cursor.source_high_water_mark AS sourceHighWaterMark
      FROM (VALUES ${allocationValuesSql}) AS candidates(source_partition, increment_count)
      INNER JOIN app.review_delta_reconciliation_cursor cursor
        ON cursor.source_partition = candidates.source_partition
    `)

    rows.reduce((mapped, row) => {
      mapped.set(row.sourcePartition, getBulkSourceHighWaterMarkNumber(row.sourceHighWaterMark))

      return mapped
    }, sourceHighWaterByPartition)
  }, Promise.resolve())

  return sourceHighWaterByPartition
}

const getResolvedBulkDeltas = async <TInput extends BulkDeltaAppendInput>({
  prepared,
  tx,
}: {
  prepared: readonly PreparedBulkDelta<TInput>[]
  tx: ReviewServingDeltaLedgerTransaction
}) => {
  const allocationCountsByPartition = getBulkSourceHighWaterAllocations(prepared)
  const rangeEndByPartition = await allocateBulkSourceHighWaterMarkRanges({allocationCountsByPartition, tx})
  const nextSourceHighWaterByPartition = new Map(
    [...allocationCountsByPartition.entries()].map(([sourcePartition, incrementCount]) => {
      const rangeEnd = rangeEndByPartition.get(sourcePartition)

      if (rangeEnd === undefined) {
        throw new Error(`failed to allocate bulk review-serving source high-water range for ${sourcePartition}`)
      }

      return [sourcePartition, rangeEnd - incrementCount + 1] as const
    }),
  )

  return prepared.map((row): ResolvedBulkDelta<TInput> => {
    const allocatedSourceHighWaterMark = row.input.allocatedSourceHighWaterMark

    if (allocatedSourceHighWaterMark !== null && allocatedSourceHighWaterMark !== undefined) {
      return {...row, advanceCursor: false, sourceHighWaterMark: allocatedSourceHighWaterMark}
    }

    const sourceHighWaterMark = nextSourceHighWaterByPartition.get(row.input.sourcePartition)

    if (sourceHighWaterMark === undefined) {
      throw new Error(`failed to resolve bulk review-serving source high-water mark for ${row.input.sourcePartition}`)
    }

    nextSourceHighWaterByPartition.set(row.input.sourcePartition, sourceHighWaterMark + 1)

    return {...row, advanceCursor: false, sourceHighWaterMark}
  })
}

const getBulkDeltaTempTableName = () => {
  return `temp_review_serving_delta_bulk_${randomUUID().replaceAll('-', '_')}`
}

const getCreateBulkDeltaTempTableSql = (tableName: string) => {
  return `
    CREATE TEMP TABLE ${tableName} (
      input_index BIGINT NOT NULL,
      delta_id VARCHAR NOT NULL,
      change_kind VARCHAR NOT NULL,
      source_table VARCHAR NOT NULL,
      source_row_id VARCHAR NOT NULL,
      source_operation VARCHAR NOT NULL,
      source_partition VARCHAR NOT NULL,
      source_high_water_mark BIGINT NOT NULL,
      source_updated_at TIMESTAMPTZ,
      idempotency_key VARCHAR NOT NULL,
      payload_version INTEGER NOT NULL,
      tombstone BOOLEAN NOT NULL,
      payload_json JSON,
      advance_cursor BOOLEAN NOT NULL,
      project_id VARCHAR,
      article_id VARCHAR,
      prompt_id VARCHAR,
      model_id VARCHAR,
      use_title BOOLEAN,
      use_abstract BOOLEAN,
      use_fulltext BOOLEAN,
      use_fulltext_no_images BOOLEAN,
      judgment_id VARCHAR,
      human_judgment_key VARCHAR,
      config_field_set VARCHAR,
      import_run_id VARCHAR,
      import_route_id VARCHAR,
      source_record_key VARCHAR,
      source_record_hash VARCHAR,
      selected_rank_key VARCHAR,
      publication_year INTEGER
    )
  `
}

const getCommonBulkDeltaRowValues = <TInput extends BulkDeltaAppendInput>(row: ResolvedBulkDelta<TInput>) => {
  return [
    String(row.inputIndex),
    getSqlLiteral(row.deltaId),
    getSqlLiteral(row.changeKind),
    getSqlLiteral(row.input.sourceTable),
    getSqlLiteral(row.input.sourceRowId),
    getSqlLiteral(row.input.sourceOperation),
    getSqlLiteral(row.input.sourcePartition),
    String(row.sourceHighWaterMark),
    getReviewServingTimestampLiteral(row.input.sourceUpdatedAt),
    getSqlLiteral(row.idempotencyKey),
    String(row.input.payloadVersion),
    getSqlLiteral(getReviewServingDeltaTombstone(row.input)),
    getReviewServingJsonLiteral(getReviewServingPayloadValue(row.input.payloadJson)),
    getSqlLiteral(row.advanceCursor),
  ]
}

const getReviewChangeBulkRowValuesSql = (row: ResolvedBulkDelta<ReviewServingDeltaAppendInput>) => {
  return `(${[
    ...getCommonBulkDeltaRowValues(row),
    getSqlLiteral(row.input.projectId),
    getSqlLiteral(row.input.articleId),
    getSqlLiteral(row.input.promptId),
    getSqlLiteral(row.input.modelId),
    getSqlLiteral(row.input.useTitle),
    getSqlLiteral(row.input.useAbstract),
    getSqlLiteral(row.input.useFulltext),
    getSqlLiteral(row.input.useFulltextNoImages),
    getSqlLiteral(row.input.judgmentId),
    getSqlLiteral(row.input.humanJudgmentKey),
    getSqlLiteral(row.input.configFieldSet),
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
  ].join(', ')})`
}

const getImportRunArticleBulkRowValuesSql = (row: ResolvedBulkDelta<ReviewServingImportRunArticleDeltaAppendInput>) => {
  return `(${[
    ...getCommonBulkDeltaRowValues(row),
    'NULL',
    getSqlLiteral(row.input.articleId),
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    getSqlLiteral(row.input.importRunId),
    getSqlLiteral(row.input.importRouteId),
    getSqlLiteral(row.input.sourceRecordKey),
    getSqlLiteral(row.input.sourceRecordHash),
    getSqlLiteral(row.input.selectedRankKey),
    getSqlLiteral(row.input.publicationYear),
  ].join(', ')})`
}

const getReviewChangeBulkInsertSql = (tableName: string) => {
  return `
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
      payload_json,
      created_at,
      reconciled_at
    )
    SELECT
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
      payload_json,
      current_timestamp,
      NULL
    FROM ${tableName}
    ORDER BY input_index ASC
  `
}

const getImportRunArticleBulkInsertSql = (tableName: string) => {
  return `
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
      payload_json,
      created_at,
      reconciled_at
    )
    SELECT
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
      payload_json,
      current_timestamp,
      NULL
    FROM ${tableName}
    ORDER BY input_index ASC
  `
}

const loadBulkDeltaTempRows = async <TInput extends BulkDeltaAppendInput>({
  getRowValuesSql,
  rows,
  tableName,
  tx,
}: {
  getRowValuesSql: (row: ResolvedBulkDelta<TInput>) => string
  rows: readonly ResolvedBulkDelta<TInput>[]
  tableName: string
  tx: ReviewServingDeltaLedgerTransaction
}) => {
  await getReviewServingBulkValueChunks(rows).reduce<Promise<void>>(async (previous, chunk) => {
    await previous
    await tx.run(`
      INSERT INTO ${tableName} (${reviewServingBulkTempColumns.join(', ')})
      VALUES ${chunk.map(getRowValuesSql).join(', ')}
    `)
  }, Promise.resolve())
}

const writeBulkDeltas = async <TInput extends BulkDeltaAppendInput>({
  rows,
  target,
  tx,
}: {
  rows: readonly ResolvedBulkDelta<TInput>[]
  target: BulkDeltaTarget<TInput>
  tx: ReviewServingDeltaLedgerTransaction
}) => {
  const tableName = getBulkDeltaTempTableName()
  await tx.run(getCreateBulkDeltaTempTableSql(tableName))

  try {
    await loadBulkDeltaTempRows({getRowValuesSql: target.getRowValuesSql, rows, tableName, tx})

    await tx.run(target.getTargetInsertSql(tableName))
  } catch (error) {
    await tx.run(`DROP TABLE IF EXISTS ${tableName}`).catch(() => {
      return undefined
    })
    throw error
  }

  await tx.run(`DROP TABLE IF EXISTS ${tableName}`)
}

const getBulkDeltaResults = <TInput extends BulkDeltaAppendInput>({
  existingByIdempotencyKey,
  prepared,
  resolved,
}: {
  existingByIdempotencyKey: ReadonlyMap<string, ExistingDeltaRow>
  prepared: readonly PreparedBulkDelta<TInput>[]
  resolved: readonly ResolvedBulkDelta<TInput>[]
}) => {
  const resolvedByIdempotencyKey = new Map(
    resolved.map((row) => {
      return [row.idempotencyKey, row] as const
    }),
  )

  return prepared.map((row): ReviewServingDeltaAppendResult => {
    const existing = existingByIdempotencyKey.get(row.idempotencyKey)

    if (existing !== undefined) {
      return {...existing, idempotencyKey: row.idempotencyKey, inserted: false}
    }

    const inserted = resolvedByIdempotencyKey.get(row.idempotencyKey)

    if (inserted === undefined) {
      throw new Error(`failed to resolve bulk review-serving delta ${row.idempotencyKey}`)
    }

    return {
      deltaId: inserted.deltaId,
      idempotencyKey: row.idempotencyKey,
      inserted: inserted.inputIndex === row.inputIndex,
      sourceHighWaterMark: inserted.sourceHighWaterMark,
    }
  })
}

const appendReviewServingBulkDeltas = async <TInput extends BulkDeltaAppendInput>(
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly TInput[],
  target: BulkDeltaTarget<TInput>,
): Promise<ReviewServingDeltaAppendResult[]> => {
  const prepared = getPreparedBulkDeltas(inputs)

  if (prepared.length === 0) {
    return []
  }

  const uniquePrepared = getUniquePreparedBulkDeltas(prepared)
  const existingByIdempotencyKey = await getExistingBulkDeltas({prepared: uniquePrepared, table: target.table, tx})
  const pending = uniquePrepared.filter((row) => {
    return !existingByIdempotencyKey.has(row.idempotencyKey)
  })
  const resolved = await getResolvedBulkDeltas({prepared: pending, tx})

  if (resolved.length > 0) {
    await writeBulkDeltas({rows: resolved, target, tx})
  }

  return getBulkDeltaResults({existingByIdempotencyKey, prepared, resolved})
}

const reviewChangeBulkTarget: BulkDeltaTarget<ReviewServingDeltaAppendInput> = {
  getRowValuesSql: getReviewChangeBulkRowValuesSql,
  getTargetInsertSql: getReviewChangeBulkInsertSql,
  table: 'app.review_change_delta',
}

const importRunArticleBulkTarget: BulkDeltaTarget<ReviewServingImportRunArticleDeltaAppendInput> = {
  getRowValuesSql: getImportRunArticleBulkRowValuesSql,
  getTargetInsertSql: getImportRunArticleBulkInsertSql,
  table: 'app.import_run_article_delta',
}

export const appendReviewServingChangeDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly ReviewServingDeltaAppendInput[],
): Promise<ReviewServingDeltaAppendResult[]> => {
  return appendReviewServingBulkDeltas(tx, inputs, reviewChangeBulkTarget)
}

export const appendReviewServingImportRunArticleDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly ReviewServingImportRunArticleDeltaAppendInput[],
): Promise<ReviewServingDeltaAppendResult[]> => {
  return appendReviewServingBulkDeltas(tx, inputs, importRunArticleBulkTarget)
}

export const allocateReviewServingSourceHighWaterMark = async (
  tx: ReviewServingDeltaLedgerTransaction,
  sourcePartition: string,
) => {
  await tx.run(`
    INSERT INTO app.review_delta_reconciliation_cursor (source_partition, source_high_water_mark)
    SELECT ${getSqlLiteral(sourcePartition)}, 0
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.review_delta_reconciliation_cursor
      WHERE source_partition = ${getSqlLiteral(sourcePartition)}
    )
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
  const changeKind = validateReviewServingChangeKind(input.changeKind)
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
  const sourceHighWaterMark =
    input.allocatedSourceHighWaterMark ?? (await allocateReviewServingSourceHighWaterMark(tx, input.sourcePartition))

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
      payload_json,
      created_at,
      reconciled_at
    ) VALUES (
      ${getSqlLiteral(deltaId)},
      ${getSqlLiteral(changeKind)},
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
      ${getSqlLiteral(getReviewServingDeltaTombstone(input))},
      ${getReviewServingJsonLiteral(getReviewServingPayloadValue(input.payloadJson))},
      current_timestamp,
      NULL
    )
  `)

  return {deltaId, idempotencyKey, inserted: true, sourceHighWaterMark}
}

export const appendReviewServingImportRunArticleDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewServingImportRunArticleDeltaAppendInput,
): Promise<ReviewServingDeltaAppendResult> => {
  const changeKind = validateReviewServingChangeKind(input.changeKind)
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
  const sourceHighWaterMark =
    input.allocatedSourceHighWaterMark ?? (await allocateReviewServingSourceHighWaterMark(tx, input.sourcePartition))

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
      payload_json,
      created_at,
      reconciled_at
    ) VALUES (
      ${getSqlLiteral(deltaId)},
      ${getSqlLiteral(changeKind)},
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
      ${getSqlLiteral(getReviewServingDeltaTombstone(input))},
      ${getReviewServingJsonLiteral(getReviewServingPayloadValue(input.payloadJson))},
      current_timestamp,
      NULL
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

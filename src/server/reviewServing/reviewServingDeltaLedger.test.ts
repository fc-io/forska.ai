import {expect, test} from 'bun:test'

import {
  appendReviewServingChangeDelta,
  appendReviewServingImportRunArticleDelta,
  appendReviewServingSourceChangeOutbox,
  getReviewServingDeltaIdempotencyKey,
  type ReviewServingDeltaLedgerTransaction,
} from './reviewServingDeltaLedger.ts'

const baseIdempotencyInput = {
  sourceMutationKey: 'judgment:judgment-1:v2',
  sourceOperation: 'upsert',
  sourcePartition: 'judgment:project-1',
  sourceRowId: 'judgment-1',
  sourceTable: 'app.judgment',
  typedKey: {articleId: 'article-1', promptId: 'prompt-1'},
} as const

type FakeLedgerTransactionOptions = {
  existingDelta?: {deltaId: string; idempotencyKey: string; sourceHighWaterMark: number}
  existingOutbox?: {idempotencyKey: string; outboxId: string; sourceHighWaterMark: number}
}

const createFakeLedgerTransaction = (options: FakeLedgerTransactionOptions = {}) => {
  const statements: string[] = []
  const highWaterByPartition: Record<string, number> = {}
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (
        options.existingDelta
        && statement.includes('FROM app.review_change_delta')
        && statement.includes(options.existingDelta.idempotencyKey)
      ) {
        return [
          {deltaId: options.existingDelta.deltaId, sourceHighWaterMark: options.existingDelta.sourceHighWaterMark},
        ] as T[]
      }

      if (
        options.existingOutbox
        && statement.includes('FROM app.review_source_change_outbox')
        && statement.includes(options.existingOutbox.idempotencyKey)
      ) {
        return [
          {outboxId: options.existingOutbox.outboxId, sourceHighWaterMark: options.existingOutbox.sourceHighWaterMark},
        ] as T[]
      }

      if (statement.includes('FROM app.review_delta_reconciliation_cursor')) {
        const sourcePartition = statement.match(/source_partition = '([^']+)'/)?.[1] ?? ''

        return [{sourceHighWaterMark: highWaterByPartition[sourcePartition] ?? 0}] as T[]
      }

      return []
    },
    run: async (statement: string) => {
      statements.push(statement)

      if (statement.includes('UPDATE app.review_delta_reconciliation_cursor')) {
        const sourcePartition = statement.match(/source_partition = '([^']+)'/)?.[1] ?? ''
        highWaterByPartition[sourcePartition] = (highWaterByPartition[sourcePartition] ?? 0) + 1
      }
    },
  }

  return {statements, tx}
}

const getInsertStatement = (statements: string[], tableName: string) => {
  return statements.find((statement) => {
    return statement.includes(`INSERT INTO ${tableName}`)
  })
}

test('review-serving delta idempotency keys are deterministic from stable source identity', () => {
  const first = getReviewServingDeltaIdempotencyKey({
    ...baseIdempotencyInput,
    typedKey: {articleId: 'article-1', promptId: 'prompt-1'},
  })
  const second = getReviewServingDeltaIdempotencyKey({
    ...baseIdempotencyInput,
    typedKey: {promptId: 'prompt-1', articleId: 'article-1'},
  })
  const differentMutation = getReviewServingDeltaIdempotencyKey({
    ...baseIdempotencyInput,
    sourceMutationKey: 'judgment:judgment-1:v3',
  })

  expect(first).toBe(second)
  expect(first).toStartWith('review-serving-delta:')
  expect(first).not.toBe(differentMutation)
})

test('import article delta idempotency keys are deterministic from stable source identity', () => {
  const first = getReviewServingDeltaIdempotencyKey({
    sourceMutationKey: 'import-run-article:run-1:route-1:record-1:v1',
    sourceOperation: 'upsert',
    sourcePartition: 'importRoute:route-1',
    sourceRowId: 'run-1:record-1',
    sourceTable: 'app.import_run_article',
    typedKey: {articleId: 'article-1', importRouteId: 'route-1', importSourceRecordKey: 'record-1'},
  })
  const second = getReviewServingDeltaIdempotencyKey({
    sourceMutationKey: 'import-run-article:run-1:route-1:record-1:v1',
    sourceOperation: 'upsert',
    sourcePartition: 'importRoute:route-1',
    sourceRowId: 'run-1:record-1',
    sourceTable: 'app.import_run_article',
    typedKey: {importSourceRecordKey: 'record-1', importRouteId: 'route-1', articleId: 'article-1'},
  })

  expect(first).toBe(second)
  expect(first).toStartWith('review-serving-delta:')
})

test('duplicate review-serving delta append returns existing identity without high-water allocation', async () => {
  const idempotencyKey = getReviewServingDeltaIdempotencyKey(baseIdempotencyInput)
  const {statements, tx} = createFakeLedgerTransaction({
    existingDelta: {deltaId: 'delta-existing', idempotencyKey, sourceHighWaterMark: 12},
  })
  const result = await appendReviewServingChangeDelta(tx, {
    ...baseIdempotencyInput,
    changeKind: 'judgment.llm.updated',
    payloadVersion: 1,
  })

  expect(result).toEqual({deltaId: 'delta-existing', idempotencyKey, inserted: false, sourceHighWaterMark: 12})
  expect(
    statements.some((statement) => {
      return statement.includes('UPDATE app.review_delta_reconciliation_cursor')
    }),
  ).toBe(false)
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_change_delta')
    }),
  ).toBe(false)
})

test('review-serving delta append rejects unknown change kinds before high-water allocation', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  const error = await appendReviewServingChangeDelta(tx, {
    ...baseIdempotencyInput,
    changeKind: 'judgment.llm.moved' as never,
    payloadVersion: 1,
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught instanceof Error ? caught : new Error(String(caught))
    },
  )

  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toBe('unknown review-serving change kind: judgment.llm.moved')
  expect(
    statements.some((statement) => {
      return statement.includes('review_delta_reconciliation_cursor')
    }),
  ).toBe(false)
})

test('import article delta appends common envelope fields without affected-project fanout', async () => {
  const {statements, tx} = createFakeLedgerTransaction()
  const result = await appendReviewServingImportRunArticleDelta(tx, {
    articleId: 'article-1',
    changeKind: 'importRoute.article.added',
    importRouteId: 'route-1',
    importRunId: 'run-1',
    payloadJson: {rank: 3, source: 'import'},
    payloadVersion: 1,
    publicationYear: 2024,
    selectedRankKey: '000003',
    sourceMutationKey: 'import-run-article:run-1:route-1:record-1:v1',
    sourceOperation: 'upsert',
    sourcePartition: 'importRoute:route-1',
    sourceRecordHash: 'hash-1',
    sourceRecordKey: 'record-1',
    sourceRowId: 'run-1:record-1',
    sourceTable: 'app.import_run_article',
    sourceUpdatedAt: '2026-06-15T12:00:00.000Z',
    typedKey: {articleId: 'article-1', importRouteId: 'route-1', importRunId: 'run-1', sourceRecordKey: 'record-1'},
  })
  const insertStatement = getInsertStatement(statements, 'app.import_run_article_delta') ?? ''
  const envelopeColumns = [
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
    'payload_json',
    'created_at',
    'reconciled_at',
  ]
  const typedKeyColumns = [
    'import_run_id',
    'import_route_id',
    'article_id',
    'source_record_key',
    'source_record_hash',
    'selected_rank_key',
    'publication_year',
  ]

  expect(result.inserted).toBe(true)
  expect(result.sourceHighWaterMark).toBe(1)
  expect(
    envelopeColumns.every((columnName) => {
      return insertStatement.includes(columnName)
    }),
  ).toBe(true)
  expect(
    typedKeyColumns.every((columnName) => {
      return insertStatement.includes(columnName)
    }),
  ).toBe(true)
  expect(insertStatement).toContain('current_timestamp')
  expect(insertStatement).toContain('NULL')
  expect(insertStatement).not.toContain('project_id')
  expect(statements.join('\n')).not.toContain('affected_project')
  expect(statements.join('\n')).not.toContain('mart.review')
  expect(insertStatement).toContain('record-1')
})

test('import removal deltas default to tombstones for replay after removals', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendReviewServingImportRunArticleDelta(tx, {
    articleId: 'article-1',
    changeKind: 'importRoute.article.removed',
    importRouteId: 'route-1',
    importRunId: 'run-1',
    payloadVersion: 1,
    sourceMutationKey: 'import-run-article:run-1:route-1:record-1:removed',
    sourceOperation: 'delete',
    sourcePartition: 'importRoute:route-1',
    sourceRecordKey: 'record-1',
    sourceRowId: 'run-1:record-1',
    sourceTable: 'app.import_run_article',
    typedKey: {articleId: 'article-1', importRouteId: 'route-1', importSourceRecordKey: 'record-1'},
  })
  const insertStatement = getInsertStatement(statements, 'app.import_run_article_delta') ?? ''

  expect(insertStatement).toContain('importRoute.article.removed')
  expect(insertStatement).toContain('TRUE')
})

test('review delete deltas default to tombstones for replay after source deletes', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendReviewServingChangeDelta(tx, {
    ...baseIdempotencyInput,
    changeKind: 'judgment.llm.deleted',
    payloadVersion: 1,
  })
  const insertStatement = getInsertStatement(statements, 'app.review_change_delta') ?? ''

  expect(insertStatement).toContain('judgment.llm.deleted')
  expect(insertStatement).toContain('TRUE')
})

test('new review-serving outbox appends allocate monotonic source high-water marks per partition', async () => {
  const {tx} = createFakeLedgerTransaction()
  const first = await appendReviewServingSourceChangeOutbox(tx, {
    ...baseIdempotencyInput,
    payloadVersion: 1,
    recoveryPayloadJson: {source: 'first'},
  })
  const second = await appendReviewServingSourceChangeOutbox(tx, {
    ...baseIdempotencyInput,
    sourceMutationKey: 'judgment:judgment-2:v1',
    sourceRowId: 'judgment-2',
    payloadVersion: 1,
    recoveryPayloadJson: {source: 'second'},
  })

  expect(first.inserted).toBe(true)
  expect(second.inserted).toBe(true)
  expect(first.sourceHighWaterMark).toBe(1)
  expect(second.sourceHighWaterMark).toBe(2)
  expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
})

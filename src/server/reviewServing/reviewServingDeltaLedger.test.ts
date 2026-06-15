import {expect, test} from 'bun:test'

import {
  appendReviewServingChangeDelta,
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

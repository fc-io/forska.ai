import {expect, test} from 'bun:test'

import {
  getReviewServingDeltaIdempotencyKey,
  type ReviewServingDeltaLedgerTransaction,
} from './reviewServingDeltaLedger.ts'
import {
  advanceReviewServingProjectorWatermark,
  reconcileReviewServingDeltaOutboxRow,
  type ReviewServingOutboxBarrier,
} from './reviewServingDeltaReconciliation.ts'

const sourceIdentity = {
  sourceMutationKey: 'judgment:judgment-1:v2',
  sourceOperation: 'upsert',
  sourcePartition: 'judgment:project-1',
  sourceRowId: 'judgment-1',
  sourceTable: 'app.judgment',
  typedKey: {articleId: 'article-1', promptId: 'prompt-1'},
} as const

const idempotencyKey = getReviewServingDeltaIdempotencyKey(sourceIdentity)

const validReviewRecoveryPayload = {
  changeKind: 'judgment.llm.updated',
  deltaTable: 'review_change_delta',
  judgmentId: 'judgment-1',
  projectId: 'project-1',
  sourceMutationKey: sourceIdentity.sourceMutationKey,
  typedKey: sourceIdentity.typedKey,
} as const

type FakeOutboxRow = {
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

const validReviewOutboxRow: FakeOutboxRow = {
  idempotencyKey,
  outboxId: 'outbox-1',
  payloadVersion: 1,
  recoveryPayloadJson: validReviewRecoveryPayload,
  retryCount: 0,
  sourceHighWaterMark: 42,
  sourceOperation: sourceIdentity.sourceOperation,
  sourcePartition: sourceIdentity.sourcePartition,
  sourceRowId: sourceIdentity.sourceRowId,
  sourceTable: sourceIdentity.sourceTable,
  sourceUpdatedAt: '2026-06-15T12:00:00.000Z',
  status: 'pending',
}

const createFakeReconciliationTransaction = (
  options: {barrier?: ReviewServingOutboxBarrier | null; outboxRow?: FakeOutboxRow | null} = {},
) => {
  const statements: string[] = []
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox') && statement.includes('WHERE outbox_id')) {
        return options.outboxRow ? ([options.outboxRow] as T[]) : []
      }

      if (
        statement.includes('FROM app.review_source_change_outbox')
        && statement.includes('source_high_water_mark <=')
      ) {
        return options.barrier ? ([options.barrier] as T[]) : []
      }

      return []
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  return {statements, tx}
}

test('reconciles valid outbox rows into deltas with the allocated source high-water mark', async () => {
  const {statements, tx} = createFakeReconciliationTransaction({outboxRow: validReviewOutboxRow})
  const result = await reconcileReviewServingDeltaOutboxRow(tx, {outboxId: 'outbox-1'})
  const insertDelta =
    statements.find((statement) => {
      return statement.includes('INSERT INTO app.review_change_delta')
    }) ?? ''
  const markReconciled =
    statements.find((statement) => {
      return statement.includes("status = 'reconciled'")
    }) ?? ''

  expect(result).toEqual({outboxId: 'outbox-1', sourceHighWaterMark: 42, status: 'reconciled'})
  expect(insertDelta).toContain('42')
  expect(insertDelta).toContain('judgment.llm.updated')
  expect(markReconciled).toContain('reconciled_at = current_timestamp')
  expect(
    statements.some((statement) => {
      return statement.includes('UPDATE app.review_delta_reconciliation_cursor')
    }),
  ).toBe(false)
})

test('malformed outbox rows retry before quarantine and are not converted to deltas', async () => {
  const retryableRow = {
    ...validReviewOutboxRow,
    recoveryPayloadJson: {deltaTable: 'review_change_delta'},
    retryCount: 0,
  }
  const quarantinedRow = {...validReviewOutboxRow, recoveryPayloadJson: null, retryCount: 1}
  const retryableTx = createFakeReconciliationTransaction({outboxRow: retryableRow})
  const quarantinedTx = createFakeReconciliationTransaction({outboxRow: quarantinedRow})
  const retryable = await reconcileReviewServingDeltaOutboxRow(retryableTx.tx, {maxRetries: 2, outboxId: 'outbox-1'})
  const quarantined = await reconcileReviewServingDeltaOutboxRow(quarantinedTx.tx, {
    maxRetries: 2,
    outboxId: 'outbox-1',
  })

  expect(retryable).toEqual({
    outboxId: 'outbox-1',
    reason: 'malformed recovery payload',
    retryCount: 1,
    status: 'retryable',
  })
  expect(quarantined).toEqual({
    outboxId: 'outbox-1',
    reason: 'malformed recovery payload',
    retryCount: 2,
    status: 'quarantined',
  })
  expect(retryableTx.statements.join('\n')).not.toContain('INSERT INTO app.review_change_delta')
  expect(quarantinedTx.statements.join('\n')).toContain('quarantined_at = current_timestamp')
})

test('outbox idempotency mismatches are quarantinable malformed rows', async () => {
  const row = {
    ...validReviewOutboxRow,
    recoveryPayloadJson: {...validReviewRecoveryPayload, sourceMutationKey: 'judgment:other:v1'},
    retryCount: 2,
  }
  const {statements, tx} = createFakeReconciliationTransaction({outboxRow: row})
  const result = await reconcileReviewServingDeltaOutboxRow(tx, {maxRetries: 3, outboxId: 'outbox-1'})

  expect(result).toEqual({
    outboxId: 'outbox-1',
    reason: 'outbox recovery payload does not match idempotency key',
    retryCount: 3,
    status: 'quarantined',
  })
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_change_delta')
})

test('delta conversion validation failures retry instead of becoming successful paths', async () => {
  const row = {
    ...validReviewOutboxRow,
    recoveryPayloadJson: {...validReviewRecoveryPayload, changeKind: 'judgment.llm.moved'},
  }
  const {statements, tx} = createFakeReconciliationTransaction({outboxRow: row})
  const result = await reconcileReviewServingDeltaOutboxRow(tx, {outboxId: 'outbox-1'})

  expect(result).toEqual({
    outboxId: 'outbox-1',
    reason: 'unknown review-serving change kind: judgment.llm.moved',
    retryCount: 1,
    status: 'retryable',
  })
  expect(statements.join('\n')).not.toContain("status = 'reconciled'")
})

test('unreconciled outbox rows block projector watermark advancement', async () => {
  const {statements, tx} = createFakeReconciliationTransaction({
    barrier: {outboxId: 'outbox-blocked', sourceHighWaterMark: 7, status: 'quarantined'},
  })
  const error = await advanceReviewServingProjectorWatermark(tx, {
    projectionComponent: 'llmStatus',
    projectorName: 'review-serving-v4-llm',
    sourceHighWaterMark: 10,
    sourcePartition: 'judgment:project-1',
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught instanceof Error ? caught : new Error(String(caught))
    },
  )

  expect(error?.message).toBe(
    'review-serving watermark blocked by unreconciled outbox outbox-blocked at 7 (quarantined)',
  )
  expect(statements.join('\n')).toContain("status NOT IN ('operator_terminal', 'reconciled')")
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_serving_projector_watermark')
})

test('projector watermark advancement proceeds only after reconciliation or operator terminal status', async () => {
  const {statements, tx} = createFakeReconciliationTransaction({barrier: null})

  await advanceReviewServingProjectorWatermark(tx, {
    projectionComponent: 'llmStatus',
    projectorName: 'review-serving-v4-llm',
    sourceHighWaterMark: 10,
    sourcePartition: 'judgment:project-1',
  })

  expect(statements.join('\n')).toContain("status NOT IN ('operator_terminal', 'reconciled')")
  expect(statements.join('\n')).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(statements.join('\n')).toContain('ON CONFLICT(watermark_id) DO UPDATE SET')
  expect(statements.join('\n')).toContain('GREATEST(')
  expect(statements.join('\n')).toContain('app.review_serving_projector_watermark.source_high_water_mark')
  expect(statements.join('\n')).toContain('excluded.source_high_water_mark')
})

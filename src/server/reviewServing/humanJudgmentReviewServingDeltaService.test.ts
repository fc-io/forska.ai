import {expect, test} from 'bun:test'

import {
  appendHumanJudgmentReviewServingDelta,
  appendHumanJudgmentReviewServingDeltas,
} from './humanJudgmentReviewServingDeltaService.ts'
import type {ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'
import {getReviewServingInvalidationRuleOrNull} from './reviewServingInvalidationRegistry.ts'

const createFakeLedgerTransaction = () => {
  const statements: string[] = []
  const highWaterByPartition: Record<string, number> = {}
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

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

const getReviewChangeInsertStatements = (statements: string[]) => {
  return statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_change_delta')
  })
}

test('prompt human judgment updates emit human dirty deltas', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendHumanJudgmentReviewServingDeltas(tx, [
    {
      answer: 'yes',
      articleId: 'article-1',
      humanJudgmentKey: 'judgment-human-1',
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceMutationKey: 'human-submit-1',
      sourceOperation: 'update',
    },
  ])

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('judgment.human.updated')
  expect(inserts).toContain('judgment-human-1')
  expect(inserts).toContain('prompt-1')
  expect(inserts).toContain('app.judgment_human')
})

test('prompt human reviewer actions can create row-scoped overlays tied to delta high-water marks', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendHumanJudgmentReviewServingDelta(tx, {
    answer: 'include',
    articleId: 'article-1',
    comment: 'reviewed by human',
    humanJudgmentKey: 'judgment-human-1',
    projectId: 'project-1',
    promptId: 'prompt-1',
    reviewerOverlay: {readSurface: 'row', reviewConfigHash: 'review-config-1', ttlMs: 60_000},
    sourceMutationKey: 'human-submit-1',
    sourceOperation: 'update',
    sourceUpdatedAt: '2026-06-16T10:00:00.000Z',
  })

  const overlayInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_write_overlay')
  })

  expect(overlayInsert).toContain('humanJudgment.answer')
  expect(overlayInsert).toContain('review-config-1')
  expect(overlayInsert).toContain('humanJudgment:project-1:article-1')
  expect(overlayInsert).toContain('source_high_water_mark')
  expect(overlayInsert).toContain('include')
  expect(overlayInsert).toContain('reviewed by human')
  expect(
    statements.some((statement) => {
      return statement.includes('mart.review_') || statement.includes('app.review_serving_snapshot_manifest')
    }),
  ).toBe(false)
})

test('summary human judgment updates do not require promptId', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendHumanJudgmentReviewServingDelta(tx, {
    answer: 'maybe',
    articleId: 'article-summary-1',
    humanJudgmentKey: 'project-1:article-summary-1:summary',
    projectId: 'project-1',
    sourceMutationKey: 'summary-human-1',
    sourceOperation: 'upsert',
  })

  const inserts = getReviewChangeInsertStatements(statements).join('\n')
  const rule = getReviewServingInvalidationRuleOrNull('judgment.human.updated')

  expect(inserts).toContain('judgment.human.updated')
  expect(inserts).toContain('project-1:article-summary-1:summary')
  expect(inserts).toContain('app.judgment_human_summary')
  expect(inserts).not.toContain('prompt-')
  expect(rule?.affectedComponents).toEqual(['humanStatus', 'queue', 'payload', 'posting', 'summary'])
  expect(rule?.requiredKeys).not.toContain('promptId')
})

test('human delete paths are not wired without a delete change kind', () => {
  expect(getReviewServingInvalidationRuleOrNull('judgment.human.deleted')).toBeNull()
})

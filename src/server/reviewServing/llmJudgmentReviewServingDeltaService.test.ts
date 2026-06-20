import {expect, test} from 'bun:test'

import {appendLlmJudgmentReviewServingDeltas} from './llmJudgmentReviewServingDeltaService.ts'
import type {ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'

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

test('LLM judgment deltas preserve persisted benchmark-critical model and content settings', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendLlmJudgmentReviewServingDeltas(tx, [
    {
      articleId: 'article-1',
      changeKind: 'judgment.llm.updated',
      judgmentId: 'judgment-1',
      modelId: 'model-persisted',
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceMutationKey: 'judgment-1:persisted-version-7',
      sourceOperation: 'upsert',
      sourceUpdatedAt: '2026-06-20T12:00:00.000Z',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: true,
      useTitle: false,
    },
  ])

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('judgment.llm.updated')
  expect(inserts).toContain('model-persisted')
  expect(inserts).toContain('prompt-1')
  expect(inserts).toContain('judgment-1')
  expect(inserts).toContain('FALSE')
  expect(inserts).toContain('TRUE')
  expect(inserts).toContain('llmJudgment:article-1')
  expect(inserts).not.toContain('retry')
  expect(inserts).not.toContain('fallback')
})

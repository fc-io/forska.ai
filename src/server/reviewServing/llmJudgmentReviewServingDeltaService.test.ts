import {expect, test} from 'bun:test'

import {appendLlmJudgmentReviewServingDeltas} from './llmJudgmentReviewServingDeltaService.ts'
import type {ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'

const createFakeLedgerTransaction = () => {
  const statements: string[] = []
  const highWaterByPartition = new Map<string, number>()
  const applyBulkCursorAllocation = (statement: string) => {
    for (const match of statement.matchAll(/\('([^']+)'\s*,\s*(\d+)\)/g)) {
      const sourcePartition = match[1] ?? ''
      const incrementCount = Number(match[2] ?? 0)

      highWaterByPartition.set(sourcePartition, (highWaterByPartition.get(sourcePartition) ?? 0) + incrementCount)
    }
  }
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('AS candidates(source_partition, increment_count)')) {
        return [...highWaterByPartition.entries()]
          .filter(([sourcePartition]) => {
            return statement.includes(`'${sourcePartition}'`)
          })
          .map(([sourcePartition, sourceHighWaterMark]) => {
            return {sourceHighWaterMark, sourcePartition}
          }) as T[]
      }

      if (statement.includes('FROM app.review_delta_reconciliation_cursor')) {
        const sourcePartition = statement.match(/source_partition = '([^']+)'/)?.[1] ?? ''

        return [{sourceHighWaterMark: highWaterByPartition.get(sourcePartition) ?? 0}] as T[]
      }

      return []
    },
    run: async (statement: string) => {
      statements.push(statement)

      if (statement.includes('UPDATE app.review_delta_reconciliation_cursor')) {
        applyBulkCursorAllocation(statement)
        const sourcePartition = statement.match(/source_partition = '([^']+)'/)?.[1]

        if (sourcePartition !== undefined) {
          highWaterByPartition.set(sourcePartition, (highWaterByPartition.get(sourcePartition) ?? 0) + 1)
        }
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
      systemPromptVariant: 'legacy',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: true,
      useMetadata: false,
      useTitle: false,
    },
  ])

  const inserts = getReviewChangeInsertStatements(statements)
  const bulkRows = statements
    .filter((statement) => {
      return statement.includes('INSERT INTO temp_review_serving_delta_bulk_')
    })
    .join('\n')

  expect(inserts).toHaveLength(1)
  expect(bulkRows).toContain('judgment.llm.updated')
  expect(bulkRows).toContain('model-persisted')
  expect(bulkRows).toContain('prompt-1')
  expect(bulkRows).toContain('judgment-1')
  expect(bulkRows).toContain('FALSE')
  expect(bulkRows).toContain('TRUE')
  expect(bulkRows).toContain('llmJudgment:article-1')
  expect(bulkRows).not.toContain('retry')
  expect(bulkRows).not.toContain('fallback')
})

test('LLM judgment deltas carry the system prompt variant in the typed column and payload content flags', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendLlmJudgmentReviewServingDeltas(tx, [
    {
      articleId: 'article-1',
      changeKind: 'judgment.llm.created',
      judgmentId: 'judgment-screening',
      modelId: 'model-1',
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceMutationKey: 'judgment-screening:created',
      sourceOperation: 'insert',
      systemPromptVariant: 'screening_v1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: false,
      useTitle: true,
    },
  ])

  const bulkRows = statements
    .filter((statement) => {
      return statement.includes('INSERT INTO temp_review_serving_delta_bulk_')
    })
    .join('\n')
  const reviewChangeInsert = getReviewChangeInsertStatements(statements).join('\n')

  expect(bulkRows).toContain("'screening_v1'")
  expect(bulkRows).toContain('"systemPromptVariant":"screening_v1"')
  expect(reviewChangeInsert).toContain('system_prompt_variant')
})

test('LLM judgment deltas carry article metadata in the typed column and payload content flags', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendLlmJudgmentReviewServingDeltas(tx, [
    {
      articleId: 'article-1',
      changeKind: 'judgment.llm.created',
      judgmentId: 'judgment-metadata',
      modelId: 'model-1',
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceMutationKey: 'judgment-metadata:created',
      sourceOperation: 'insert',
      systemPromptVariant: 'screening_v1',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: true,
      useTitle: true,
    },
  ])

  const bulkRows = statements
    .filter((statement) => {
      return statement.includes('INSERT INTO temp_review_serving_delta_bulk_')
    })
    .join('\n')
  const reviewChangeInsert = getReviewChangeInsertStatements(statements).join('\n')

  expect(bulkRows).toContain("'screening_v1', TRUE")
  expect(bulkRows).toContain('"useMetadata":true')
  expect(reviewChangeInsert).toContain('use_metadata')
})

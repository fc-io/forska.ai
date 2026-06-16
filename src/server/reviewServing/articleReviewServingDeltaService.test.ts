import {expect, test} from 'bun:test'

import {appendArticleReviewServingDeltas} from './articleReviewServingDeltaService.ts'
import {
  getReviewServingDeltaIdempotencyKey,
  type ReviewServingDeltaLedgerTransaction,
} from './reviewServingDeltaLedger.ts'

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

test('article title updates emit display search and judgment-input deltas in one transaction', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendArticleReviewServingDeltas(tx, {
    articleId: 'article-1',
    changedFields: ['articleTitle'],
    sourceMutationKey: 'source:title-change',
    sourceOperation: 'update',
  })

  const inserts = getReviewChangeInsertStatements(statements)

  expect(inserts).toHaveLength(3)
  expect(inserts.join('\n')).toContain('article.display.updated')
  expect(inserts.join('\n')).toContain('article.searchText.updated')
  expect(inserts.join('\n')).toContain('article.judgmentInput.updated')
  expect(inserts.join('\n')).toContain('changedDisplayFieldNames')
  expect(inserts.join('\n')).toContain('changedSearchableFieldNames')
  expect(inserts.join('\n')).toContain('affectedContentFlags')
  expect(inserts.join('\n')).toContain('useTitle')
})

test('display search and judgment-input content identities advance independently by changed field', async () => {
  const displayOnly = createFakeLedgerTransaction()
  const searchAndJudgment = createFakeLedgerTransaction()
  const judgmentOnly = createFakeLedgerTransaction()

  await appendArticleReviewServingDeltas(displayOnly.tx, {
    articleId: 'article-1',
    changedFields: ['articleAuthors'],
    sourceMutationKey: 'source:authors-change',
    sourceOperation: 'update',
  })
  await appendArticleReviewServingDeltas(searchAndJudgment.tx, {
    articleId: 'article-1',
    changedFields: ['fullText'],
    sourceMutationKey: 'source:fulltext-change',
    sourceOperation: 'update',
  })
  await appendArticleReviewServingDeltas(judgmentOnly.tx, {
    articleId: 'article-1',
    changedFields: ['fullTextPDF'],
    sourceMutationKey: 'source:pdf-change',
    sourceOperation: 'update',
  })

  const displayOnlyInserts = getReviewChangeInsertStatements(displayOnly.statements).join('\n')
  const searchAndJudgmentInserts = getReviewChangeInsertStatements(searchAndJudgment.statements).join('\n')
  const judgmentOnlyInserts = getReviewChangeInsertStatements(judgmentOnly.statements).join('\n')

  expect(displayOnlyInserts).toContain('article.display.updated')
  expect(displayOnlyInserts).not.toContain('article.searchText.updated')
  expect(displayOnlyInserts).not.toContain('article.judgmentInput.updated')
  expect(searchAndJudgmentInserts).not.toContain('article.display.updated')
  expect(searchAndJudgmentInserts).toContain('article.searchText.updated')
  expect(searchAndJudgmentInserts).toContain('article.judgmentInput.updated')
  expect(judgmentOnlyInserts).toContain('article.display.updated')
  expect(judgmentOnlyInserts).not.toContain('article.searchText.updated')
  expect(judgmentOnlyInserts).toContain('article.judgmentInput.updated')
})

test('url and metadata-only article updates emit display payload deltas', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendArticleReviewServingDeltas(tx, {
    articleId: 'article-1',
    changedFields: ['url', 'sourceMetadata', 'doi'],
    sourceMutationKey: 'source:payload-change',
    sourceOperation: 'update',
  })

  const inserts = getReviewChangeInsertStatements(statements).join('\n')

  expect(inserts).toContain('article.display.updated')
  expect(inserts).toContain('url')
  expect(inserts).toContain('sourceMetadata')
  expect(inserts).toContain('doi')
  expect(inserts).not.toContain('article.searchText.updated')
  expect(inserts).not.toContain('article.judgmentInput.updated')
})

test('article delta idempotency separates display search and judgment-input identities', () => {
  const base = {
    articleId: 'article-1',
    sourceOperation: 'update' as const,
    sourcePartition: 'article:article-1',
    sourceRowId: 'article-1',
    sourceTable: 'app.article',
  }
  const displayKey = getReviewServingDeltaIdempotencyKey({
    ...base,
    sourceMutationKey: 'source:title-change|article.display.updated',
    typedKey: {articleId: 'article-1', changedDisplayFieldNames: ['articleTitle']},
  })
  const searchKey = getReviewServingDeltaIdempotencyKey({
    ...base,
    sourceMutationKey: 'source:title-change|article.searchText.updated',
    typedKey: {articleId: 'article-1', changedSearchableFieldNames: ['articleTitle']},
  })
  const judgmentInputKey = getReviewServingDeltaIdempotencyKey({
    ...base,
    sourceMutationKey: 'source:title-change|article.judgmentInput.updated',
    typedKey: {affectedContentFlags: ['useTitle'], articleId: 'article-1'},
  })

  expect(new Set([displayKey, searchKey, judgmentInputKey]).size).toBe(3)
})

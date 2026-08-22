import {expect, test} from 'bun:test'

import {
  appendArticleReviewServingDeltas,
  appendArticleReviewServingDeltasForIds,
} from './articleReviewServingDeltaService.ts'
import {
  getReviewServingDeltaIdempotencyKey,
  type ReviewServingDeltaLedgerTransaction,
} from './reviewServingDeltaLedger.ts'

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

      return []
    },
    run: async (statement: string) => {
      statements.push(statement)

      if (statement.includes('UPDATE app.review_delta_reconciliation_cursor')) {
        applyBulkCursorAllocation(statement)
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

const getReviewChangeBulkRowStatements = (statements: string[]) => {
  return statements.filter((statement) => {
    return statement.includes('INSERT INTO temp_review_serving_delta_bulk_')
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
  const bulkRows = getReviewChangeBulkRowStatements(statements).join('\n')

  expect(inserts).toHaveLength(1)
  expect(bulkRows).toContain('article.display.updated')
  expect(bulkRows).toContain('article.searchText.updated')
  expect(bulkRows).toContain('article.judgmentInput.updated')
  expect(bulkRows).toContain('changedDisplayFieldNames')
  expect(bulkRows).toContain('changedSearchableFieldNames')
  expect(bulkRows).toContain('affectedContentFlags')
  expect(bulkRows).toContain('useTitle')
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

  const displayOnlyInserts = getReviewChangeBulkRowStatements(displayOnly.statements).join('\n')
  const searchAndJudgmentInserts = getReviewChangeBulkRowStatements(searchAndJudgment.statements).join('\n')
  const judgmentOnlyInserts = getReviewChangeBulkRowStatements(judgmentOnly.statements).join('\n')

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

  const inserts = getReviewChangeInsertStatements(statements)
  const bulkRows = getReviewChangeBulkRowStatements(statements).join('\n')

  expect(inserts).toHaveLength(1)
  expect(bulkRows).toContain('article.display.updated')
  expect(bulkRows).toContain('url')
  expect(bulkRows).toContain('sourceMetadata')
  expect(bulkRows).toContain('doi')
  expect(bulkRows).not.toContain('article.searchText.updated')
  expect(bulkRows).not.toContain('article.judgmentInput.updated')
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

test('article id batches append all distinct article deltas in one review-change insert', async () => {
  const {statements, tx} = createFakeLedgerTransaction()

  await appendArticleReviewServingDeltasForIds(tx, {
    articleIds: ['article-1', 'article-2', 'article-1'],
    changedFields: ['articleTitle'],
    sourceMutationKey: 'article-batch',
    sourceMutationKeySuffix: '2026-08-15T10:00:00.000Z',
    sourceOperation: 'insert',
  })

  const inserts = getReviewChangeInsertStatements(statements)
  const bulkRows = getReviewChangeBulkRowStatements(statements).join('\n')

  expect(inserts).toHaveLength(1)
  expect(bulkRows.match(/article\.display\.updated/g)).toHaveLength(2)
  expect(bulkRows.match(/article\.searchText\.updated/g)).toHaveLength(2)
  expect(bulkRows.match(/article\.judgmentInput\.updated/g)).toHaveLength(2)
  expect(bulkRows).toContain('article-1')
  expect(bulkRows).toContain('article-2')
})

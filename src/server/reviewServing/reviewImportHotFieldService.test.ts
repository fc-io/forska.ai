import {expect, test} from 'bun:test'

import {
  getReviewImportHotFieldProjectorColumns,
  getReviewImportHotFieldRow,
  reviewImportHotFieldProjectorColumns,
  upsertReviewImportArticleHotField,
} from './reviewImportHotFieldService.ts'
import {type ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'

const createFakeHotFieldTransaction = () => {
  const statements: string[] = []
  const tx: ReviewServingDeltaLedgerTransaction = {
    queryJson: async () => {
      return []
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  return {statements, tx}
}

test('import hot fields derive compact typed row for selected-import ranking and display', () => {
  const row = getReviewImportHotFieldRow({
    articleId: 'article-1',
    articleTitle: 'Compact title',
    conflictFlag: false,
    duplicateFlag: true,
    duplicateKey: 'study-1',
    externalId: 'NCT-1',
    filterBucketKey: 'covidence.stage',
    filterBucketValue: 'full_text',
    importRouteId: 'route-1',
    journalTitle: 'Journal A',
    publicationYear: 2024,
    sourceKind: 'covidence',
    sourceRecordHash: 'hash-1',
    sourceRecordKey: 'covidence:#1',
    sourceUpdatedAt: '2026-06-15T12:00:00.000Z',
  })

  expect(row).toMatchObject({
    articleId: 'article-1',
    articleTitle: 'Compact title',
    conflictFlag: false,
    duplicateFlag: true,
    duplicateKey: 'study-1',
    externalId: 'NCT-1',
    filterBucketKey: 'covidence.stage',
    filterBucketValue: 'full_text',
    importRouteId: 'route-1',
    journalTitle: 'Journal A',
    publicationYear: 2024,
    selectedRankNumeric: 0,
    sourceKind: 'covidence',
    sourceRecordKey: 'covidence:#1',
    tombstone: false,
  })
  expect(row.selectedRankKey).toBe('0000:article-1:covidence:#1')
})

test('missing source hot fields are typed null values without raw JSON fallback', () => {
  const row = getReviewImportHotFieldRow({
    articleId: 'article-2',
    importRouteId: 'route-1',
    sourceRecordKey: 'record-2',
  })

  expect(row).toMatchObject({
    articleTitle: null,
    conflictFlag: null,
    duplicateFlag: null,
    duplicateKey: null,
    externalId: null,
    filterBucketKey: null,
    filterBucketValue: null,
    journalTitle: null,
    publicationYear: null,
    sourceKind: null,
    tombstone: false,
  })
  expect(row.selectedRankKey).toBe('3110:article-2:record-2')
})

test('hot-field replacement writes scoped delete then compact insert without indexed conflict update', async () => {
  const {statements, tx} = createFakeHotFieldTransaction()

  await upsertReviewImportArticleHotField(tx, {
    articleId: 'article-1',
    articleTitle: 'Title',
    externalId: 'external-1',
    filterBucketKey: 'source.kind',
    filterBucketValue: 'structured-file',
    importRouteId: 'route-1',
    publicationYear: 2023,
    sourceKind: 'structured-file',
    sourceRecordKey: 'record-1',
  })

  expect(statements).toHaveLength(2)

  const [deleteStatement, insertStatement] = statements
  const statement = statements.join('\n')
  const compactColumns = [
    'selected_rank_key',
    'selected_rank_numeric',
    'publication_year',
    'article_title',
    'journal_title',
    'external_id',
    'duplicate_flag',
    'conflict_flag',
    'filter_bucket_key',
    'filter_bucket_value',
  ]
  const forbiddenRawFields = [
    'raw_payload',
    'payload_json',
    'original_data',
    'source_metadata',
    'import_metadata',
    'match_metadata',
    'audit',
    'json_extract',
    'json_merge_patch',
  ]

  expect(deleteStatement).toContain('DELETE FROM app.review_import_article_hot_field')
  expect(deleteStatement).toContain("import_route_id = 'route-1'")
  expect(deleteStatement).toContain("article_id = 'article-1'")
  expect(deleteStatement).toContain("source_record_key = 'record-1'")
  expect(insertStatement).toContain('INSERT INTO app.review_import_article_hot_field')
  expect(statement).not.toContain('ON CONFLICT')
  expect(statement).not.toContain('DO UPDATE')
  expect(
    compactColumns.every((columnName) => {
      return insertStatement.includes(columnName)
    }),
  ).toBe(true)
  expect(
    forbiddenRawFields.some((fieldName) => {
      return statement.includes(fieldName)
    }),
  ).toBe(false)
  expect(statement).not.toContain('mart.review')
  expect(statement).not.toContain('review_selected_article_import_v4')
  expect(statement).not.toContain('review_serving_snapshot_manifest')
  expect(statement).not.toContain('source_record_hash')
  expect(statement).not.toContain('duplicate_key')
  expect(statement).not.toContain('source_updated_at')
  expect(statement).not.toContain('created_at')
  expect(statement).not.toContain('updated_at')
})

test('projector column contract covers ranking, display, filters, postings, and contribution keys without raw JSON', () => {
  const allColumns = getReviewImportHotFieldProjectorColumns()
  const forbiddenColumns = [
    'raw_payload',
    'payload_json',
    'original_data',
    'source_metadata',
    'import_metadata',
    'audit_payload',
  ]

  expect(reviewImportHotFieldProjectorColumns.selectedImportRanking).toContain('selected_rank_key')
  expect(reviewImportHotFieldProjectorColumns.display).toContain('article_title')
  expect(reviewImportHotFieldProjectorColumns.filters).toContain('filter_bucket_value')
  expect(reviewImportHotFieldProjectorColumns.postings).toContain('tombstone')
  expect(reviewImportHotFieldProjectorColumns.contributionKeys).toContain('source_record_key')
  expect(
    forbiddenColumns.some((columnName) => {
      return allColumns.includes(columnName)
    }),
  ).toBe(false)
})

import {expect, test} from 'bun:test'

import {
  getScopedArticleCompatibilityValues,
  getScopedArticleImportSelectionCteSql,
  getScopedArticleMetadataExpression,
} from './scopedArticleReadAdapter.ts'

test('scoped article import selection prefers covidence metadata before stable route order', () => {
  const sql = getScopedArticleImportSelectionCteSql({articleIds: ['article-1'], projectIds: ['project-1']})

  expect(sql).toContain("json_extract_string(air.import_metadata, '$.covidence.hasDuplicateStudyRecords') = 'true'")
  expect(sql).toContain("json_extract_string(air.import_metadata, '$.covidence.hasStudyDecisionConflict') = 'true'")
  expect(sql).toContain("json_extract_string(air.import_metadata, '$.covidence.studyKey') IS NOT NULL")
  expect(sql.indexOf('CASE')).toBeLessThan(sql.indexOf('pir.project_id ASC'))
})

test('scoped article metadata expression merges canonical and scoped metadata', () => {
  const sql = getScopedArticleMetadataExpression({articleAlias: 'article', scopedImportAlias: 'scoped'})

  expect(sql).toContain('json_merge_patch')
  expect(sql.indexOf('article.source_metadata')).toBeLessThan(sql.indexOf('scoped.import_metadata'))
})

test('scoped article compatibility values merge canonical and scoped source metadata', () => {
  const values = getScopedArticleCompatibilityValues({
    canonicalArticleId: 'canonical-article',
    canonicalImportRoute: 'canonical-route',
    canonicalSourceMetadata: {
      fullTextLinks: [{label: 'Full text', url: 'https://example.com/full'}],
      journalTitle: 'Canonical Journal',
    },
    scopedImportMetadata: {covidence: {studyKey: 'study-1'}},
    selectedExternalArticleId: 'scoped-article',
    selectedImportRoute: 'scoped-route',
  })

  expect(values).toMatchObject({
    articleId: 'scoped-article',
    importRoute: 'scoped-route',
    sourceMetadata: {
      covidence: {studyKey: 'study-1'},
      fullTextLinks: [{label: 'Full text', url: 'https://example.com/full'}],
      journalTitle: 'Canonical Journal',
    },
  })
})

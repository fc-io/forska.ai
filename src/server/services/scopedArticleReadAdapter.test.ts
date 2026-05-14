import {expect, test} from 'bun:test'

import {getScopedArticleImportSelectionCteSql} from './scopedArticleReadAdapter.ts'

test('scoped article import selection prefers covidence metadata before stable route order', () => {
  const sql = getScopedArticleImportSelectionCteSql({articleIds: ['article-1'], projectIds: ['project-1']})

  expect(sql).toContain("json_extract_string(air.import_metadata, '$.covidence.hasDuplicateStudyRecords') = 'true'")
  expect(sql).toContain("json_extract_string(air.import_metadata, '$.covidence.hasStudyDecisionConflict') = 'true'")
  expect(sql).toContain("json_extract_string(air.import_metadata, '$.covidence.studyKey') IS NOT NULL")
  expect(sql.indexOf('CASE')).toBeLessThan(sql.indexOf('pir.project_id ASC'))
})

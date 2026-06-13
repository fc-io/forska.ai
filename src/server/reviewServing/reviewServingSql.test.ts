import {expect, test} from 'bun:test'

import {getReviewServingReadContract} from './reviewServingReadContracts.ts'
import {
  assertReviewServingSqlShape,
  buildReviewServingRowsSql,
  getReviewServingSqlShapeViolations,
} from './reviewServingSql.ts'

const getRequiredReviewServingReadContract = (contractKey: string) => {
  const contract = getReviewServingReadContract(contractKey)

  if (!contract) {
    throw new Error(`Missing review serving read contract: ${contractKey}`)
  }

  return contract
}

test('assertReviewServingSqlShape accepts serving-table keyset SQL', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.rows')
  const sql = buildReviewServingRowsSql({
    contract,
    cursorPredicate: '(sort_key, article_id) < (?, ?)',
    limitParameter: '?',
    projectIdParameter: '?',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
})

test('assertReviewServingSqlShape rejects raw fallback and unbounded query patterns', () => {
  const sql = `
    WITH selected_scoped_article_import AS (
      SELECT article_id, ROW_NUMBER() OVER () AS rank FROM app.article
    )
    SELECT json_extract_string(a.metadata_json, '$.year'), COUNT(*)
    FROM app.judgment j
    JOIN app.article a ON a.id = j.article_id
    GROUP BY 1
    OFFSET 100
  `
  const violations = getReviewServingSqlShapeViolations(sql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('selected scoped import CTE')
  expect(violations).toContain('window row number')
  expect(violations).toContain('offset pagination')
  expect(violations).toContain('raw article table scan')
  expect(violations).toContain('raw judgment table scan')
  expect(violations).toContain('json extraction')
  expect(violations).toContain('foreground aggregation')
})

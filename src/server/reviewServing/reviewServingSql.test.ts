import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, test} from 'bun:test'

import {getReviewServingReadContract} from './reviewServingReadContracts.ts'
import {
  assertReviewServingSqlShape,
  buildReviewServingRowsSql,
  getReviewServingSqlShapeViolations,
  getReviewServingSqlTableReferences,
  reviewServingRegisteredSqlTables,
} from './reviewServingSql.ts'
import {reviewServingSqlForbiddenPatterns} from './reviewServingSqlForbiddenPatterns.ts'

const reviewServingSourceRoot = import.meta.dir
const sqlGuardDefinitionFile = join(reviewServingSourceRoot, 'reviewServingSqlForbiddenPatterns.ts')

const getRequiredReviewServingReadContract = (contractKey: string) => {
  const contract = getReviewServingReadContract(contractKey)

  if (!contract) {
    throw new Error(`Missing review serving read contract: ${contractKey}`)
  }

  return contract
}

const getReviewServingSourceFiles = (directory: string): string[] => {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = join(directory, entry.name)

    return entry.isDirectory() ? getReviewServingSourceFiles(entryPath) : entryPath
  })
}

const getGuardedReviewServingSourceFiles = () => {
  return getReviewServingSourceFiles(reviewServingSourceRoot).filter((filePath) => {
    return filePath.endsWith('.ts') && !filePath.endsWith('.test.ts') && filePath !== sqlGuardDefinitionFile
  })
}

test('assertReviewServingSqlShape accepts serving-table keyset SQL', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.rows')
  const sql = buildReviewServingRowsSql({
    contract,
    cursorPredicate: '(sort_key, article_id) < ($sortKey, $articleId)',
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    'WHERE project_id = $projectId AND review_config_hash = $reviewConfigHash AND snapshot_id = $snapshotId AND list_mode_key = $listMode',
  )
})

test('buildReviewServingRowsSql uses payload identities for payload serving tables', () => {
  const contract = getRequiredReviewServingReadContract('review.prompt.preview')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    'WHERE project_id = $projectId AND display_identity = $displayIdentity AND payload_identity = $payloadIdentity AND snapshot_id = $snapshotId',
  )
  expect(sql).not.toContain('review_config_hash')
  expect(sql).not.toContain('list_mode_key')
})

test('buildReviewServingRowsSql uses search identities for search serving tables', () => {
  const contract = getRequiredReviewServingReadContract('review.search.tokenPrefix')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    searchTokenPrefixParameter: '$searchTokenPrefix',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    'WHERE project_id = $projectId AND search_identity = $searchIdentity AND project_scope_identity = $projectScopeIdentity AND snapshot_id = $snapshotId',
  )
  expect(sql).toContain('AND starts_with(token, $searchTokenPrefix)')
  expect(sql).not.toContain('review_config_hash')
})

test('buildReviewServingRowsSql uses null-safe config identity for snapshot manifests', () => {
  const contract = getRequiredReviewServingReadContract('review.health.snapshot')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    'WHERE project_id = $projectId AND review_config_hash IS NOT DISTINCT FROM $reviewConfigHash AND snapshot_id = $snapshotId',
  )
})

test('buildReviewServingRowsSql only emits list-mode predicates for list-mode tables', () => {
  const contract = getRequiredReviewServingReadContract('review.queue.unassessed')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    'WHERE project_id = $projectId AND review_config_hash = $reviewConfigHash AND snapshot_id = $snapshotId',
  )
  expect(sql).not.toContain('list_mode_key')
  expect(sql).toContain('ORDER BY priority_bucket ASC, activity_sort_at ASC, article_id ASC')
  expect(sql).not.toContain('sort_key')
})

test('buildReviewServingRowsSql does not pin detail article lookups to a list mode', () => {
  const contract = getRequiredReviewServingReadContract('review.detail.row')
  const sql = buildReviewServingRowsSql({
    articleIdParameter: '$articleId',
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('AND article_id = $articleId')
  expect(sql).not.toContain('list_mode_key')
})

test('buildReviewServingRowsSql applies posting filter keys before row ordering', () => {
  const contract = getRequiredReviewServingReadContract('review.filters.postings')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    filterKindParameter: '$filterKind',
    filterValueParameter: '$filterValue',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('AND filter_kind = $filterKind AND filter_value = $filterValue')
  expect(sql).toContain('ORDER BY sort_key DESC, article_id DESC')
})

test('buildReviewServingRowsSql uses count-table sort columns for count serving tables', () => {
  const contract = getRequiredReviewServingReadContract('review.prompt.badges')
  const sql = buildReviewServingRowsSql({
    contract,
    countFilterKeyParameter: '$filterKey',
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    namedCountKey: 'review.llm.assessedByPrompt',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('ORDER BY count_kind ASC, summary_definition_version ASC, filter_key ASC')
  expect(sql).not.toContain('summary_key')
  expect(sql).not.toContain('prompt_id')
})

test('buildReviewServingRowsSql scopes count lookups to the requested named summary', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.count')
  const sql = buildReviewServingRowsSql({
    contract,
    countFilterKeyParameter: '$filterKey',
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    namedCountKey: 'review.llm.assessedByPrompt',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    "AND count_kind = 'review.llm.assessedByPrompt' AND summary_definition_version = 'review-llm-assessed-by-prompt:v1' AND filter_key = $filterKey",
  )
})

test('buildReviewServingRowsSql rejects count table reads without a supported named count', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.count')

  expect(() => {
    buildReviewServingRowsSql({
      contract,
      displayIdentityParameter: '$displayIdentity',
      limitParameter: '$limit',
      listModeParameter: '$listMode',
      payloadIdentityParameter: '$payloadIdentity',
      projectIdParameter: '$projectId',
      projectScopeIdentityParameter: '$projectScopeIdentity',
      reviewConfigHashParameter: '$reviewConfigHash',
      searchIdentityParameter: '$searchIdentity',
      snapshotIdParameter: '$snapshotId',
    })
  }).toThrow('Missing supported named count key for review.llm.count')
})

test('buildReviewServingRowsSql rejects count table reads without a filter key', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.count')

  expect(() => {
    buildReviewServingRowsSql({
      contract,
      displayIdentityParameter: '$displayIdentity',
      limitParameter: '$limit',
      listModeParameter: '$listMode',
      namedCountKey: 'review.llm.assessedByPrompt',
      payloadIdentityParameter: '$payloadIdentity',
      projectIdParameter: '$projectId',
      projectScopeIdentityParameter: '$projectScopeIdentity',
      reviewConfigHashParameter: '$reviewConfigHash',
      searchIdentityParameter: '$searchIdentity',
      snapshotIdParameter: '$snapshotId',
    })
  }).toThrow('Missing count filter key for review.llm.count')
})

test('buildReviewServingRowsSql rejects physical access contracts without requested filters', () => {
  const detailContract = getRequiredReviewServingReadContract('review.detail.row')
  const searchContract = getRequiredReviewServingReadContract('review.search.tokenPrefix')
  const postingContract = getRequiredReviewServingReadContract('review.filters.postings')
  const baseParams = {
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  }

  expect(() => {
    buildReviewServingRowsSql({...baseParams, contract: detailContract})
  }).toThrow('Missing article id for review.detail.row')
  expect(() => {
    buildReviewServingRowsSql({...baseParams, contract: searchContract})
  }).toThrow('Missing search token prefix for review.search.tokenPrefix')
  expect(() => {
    buildReviewServingRowsSql({...baseParams, contract: postingContract})
  }).toThrow('Missing filter kind for review.filters.postings')
})

test('assertReviewServingSqlShape reads table references from SQL', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON p.article_id = s.article_id
    WHERE s.project_id = ?
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `

  expect(getReviewServingSqlTableReferences(sql)).toEqual([
    'mart.review_article_serving_v4',
    'mart.review_article_filter_posting_serving_v4',
  ])
})

test('assertReviewServingSqlShape rejects raw fallback query patterns', () => {
  const rawFallbackSql = `
    WITH selected_scoped_article_import AS (
      SELECT article_id, ROW_NUMBER() OVER () AS rank FROM app.article
    )
    SELECT json_extract_string(a.metadata_json, '$.year'), COUNT(*)
    FROM app.judgment j
    JOIN app.article a ON a.id = j.article_id
    JOIN app.judgment_human_summary h ON h.article_id = a.id
    WHERE j.project_id = ?
    GROUP BY 1
    ORDER BY rank DESC
    LIMIT ?
    OFFSET 100
  `
  const violations = getReviewServingSqlShapeViolations(rawFallbackSql).map((violation) => {
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

test('forbidden SQL regexes stay stateless across repeated checks', () => {
  const statefulPatternLabels = reviewServingSqlForbiddenPatterns
    .filter((forbiddenPattern) => {
      return forbiddenPattern.pattern.global || forbiddenPattern.pattern.sticky
    })
    .map((forbiddenPattern) => {
      return forbiddenPattern.label
    })
  const rawFallbackSql = 'SELECT * FROM app.article WHERE project_id = ? ORDER BY id ASC LIMIT ?'
  const firstViolationLabels = getReviewServingSqlShapeViolations(rawFallbackSql).map((violation) => {
    return violation.label
  })
  const secondViolationLabels = getReviewServingSqlShapeViolations(rawFallbackSql).map((violation) => {
    return violation.label
  })

  expect(statefulPatternLabels).toEqual([])
  expect(firstViolationLabels).toContain('raw article table scan')
  expect(secondViolationLabels).toContain('raw article table scan')
})

test('assertReviewServingSqlShape rejects unregistered tables and unbounded reads', () => {
  const unregisteredSql = `
    SELECT *
    FROM mart.review_article_rollup
    WHERE project_id = ?
    ORDER BY article_id ASC
    LIMIT ?
  `
  const unboundedSql = `
    SELECT *
    FROM mart.review_article_serving_v4
    WHERE snapshot_id = ?
  `
  const unregisteredViolations = getReviewServingSqlShapeViolations(unregisteredSql).map((violation) => {
    return violation.label
  })
  const unboundedViolations = getReviewServingSqlShapeViolations(unboundedSql).map((violation) => {
    return violation.label
  })

  expect(unregisteredViolations).toContain('unregistered table reference: mart.review_article_rollup')
  expect(unboundedViolations).toContain('project scoped read')
  expect(unboundedViolations).toContain('keyset ordering')
  expect(unboundedViolations).toContain('bounded limit')
})

test('assertReviewServingSqlShape requires snapshot scope by default', () => {
  const missingSnapshotSql = `
    SELECT *
    FROM mart.review_article_serving_v4
    WHERE project_id = ?
    ORDER BY article_id ASC
    LIMIT ?
  `
  const violations = getReviewServingSqlShapeViolations(missingSnapshotSql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('snapshot scoped read')
})

test('assertReviewServingSqlShape requires project and snapshot scope for every joined alias', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON p.article_id = s.article_id
    WHERE s.project_id = ? AND s.snapshot_id = ?
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `
  const violations = getReviewServingSqlShapeViolations(sql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('project scoped read: p')
  expect(violations).toContain('snapshot scoped read: p')
})

test('reviewServing source files are statically guarded without scanning legacy route SQL', () => {
  const sourceViolations = getGuardedReviewServingSourceFiles().flatMap((filePath) => {
    return getReviewServingSqlShapeViolations(readFileSync(filePath, 'utf8'), {
      allowedTables: reviewServingRegisteredSqlTables,
      requireLimit: false,
      requireOrderBy: false,
      requireProjectScope: false,
      requireRegisteredTable: false,
      requireSnapshotScope: false,
    }).map((violation) => {
      return `${relative(reviewServingSourceRoot, filePath)}: ${violation.label}`
    })
  })

  expect(sourceViolations).toEqual([])
})

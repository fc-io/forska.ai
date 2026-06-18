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
    return (
      filePath.endsWith('.ts')
      && !filePath.endsWith('.test.ts')
      && !filePath.endsWith('Projector.ts')
      && filePath !== sqlGuardDefinitionFile
    )
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
    "WHERE project_id = $projectId AND review_config_hash = $reviewConfigHash AND snapshot_id = $snapshotId AND list_mode_key = 'llm'",
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
  expect(sql).not.toContain('AND list_mode_key =')
  expect(sql).toContain('ORDER BY article_created_at ASC NULLS LAST, article_id ASC')
  expect(sql).not.toContain('ASC NULLS LAST ASC')
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

test('buildReviewServingRowsSql scopes filter option rows by search identity', () => {
  const contract = getRequiredReviewServingReadContract('review.filters.options')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    filterOptionIdentityParameter: '$filterOptionIdentity',
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
    'WHERE project_id = $projectId AND review_config_hash = $reviewConfigHash AND snapshot_id = $snapshotId AND search_identity = $searchIdentity AND filter_option_identity = $filterOptionIdentity',
  )
  expect(sql).toContain('ORDER BY filter_kind ASC, facet_key ASC, option_value_key ASC')
})

test('buildReviewServingRowsSql rejects filter option reads without a filter-option identity', () => {
  const contract = getRequiredReviewServingReadContract('review.filters.options')

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
  }).toThrow('Missing filter option identity for review.filters.options')
})

test('buildReviewServingRowsSql separates review and human facet rows', () => {
  const reviewContract = getRequiredReviewServingReadContract('review.filters.facets')
  const humanContract = getRequiredReviewServingReadContract('review.human.filters.facets')
  const baseParams = {
    countFilterKeyParameter: '$filterKey',
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
  const reviewSql = buildReviewServingRowsSql({...baseParams, contract: reviewContract})
  const humanSql = buildReviewServingRowsSql({...baseParams, contract: humanContract})

  expect(assertReviewServingSqlShape(reviewSql)).toEqual({ok: true, violations: []})
  expect(assertReviewServingSqlShape(humanSql)).toEqual({ok: true, violations: []})
  expect(reviewSql).toContain("AND facet_kind = 'review'")
  expect(reviewSql).toContain('AND summary_definition_version IN (')
  expect(reviewSql).toContain("'review-filter-duplicate-flag:v1'")
  expect(reviewSql).toContain("'review-filter-import-route:v1'")
  expect(reviewSql).toContain("'review-filter-prompt-answer:v1'")
  expect(reviewSql).toContain("'review-filter-publication-year:v1'")
  expect(reviewSql).toContain('AND summary_identity = $filterKey')
  expect(humanSql).toContain("AND facet_kind = 'human'")
  expect(humanSql).toContain('AND summary_definition_version IN (')
  expect(humanSql).toContain("'review-human-filter-prompt-answer:v1'")
  expect(humanSql).toContain("'review-human-filter-summary-answer:v1'")
  expect(humanSql).toContain('AND summary_identity = $filterKey')
})

test('buildReviewServingRowsSql rejects facet reads without a filter key', () => {
  const contract = getRequiredReviewServingReadContract('review.filters.facets')

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
  }).toThrow('Missing facet filter key for review.filters.facets')
})

test('buildReviewServingRowsSql pins snapshot manifests to the active review config', () => {
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

  expect(assertReviewServingSqlShape(sql, {requireSnapshotScope: false})).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    "WHERE project_id = $projectId AND review_config_hash IS NOT DISTINCT FROM $reviewConfigHash AND snapshot_status IN ('active', 'retired') ORDER BY updated_at DESC, snapshot_id DESC",
  )
  expect(sql).not.toContain(' AND status IN ')
  expect(sql).not.toContain('$snapshotId')
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
    queueKindParameter: '$queueKind',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    'WHERE project_id = $projectId AND review_config_hash = $reviewConfigHash AND snapshot_id = $snapshotId',
  )
  expect(sql).not.toContain('list_mode_key')
  expect(sql).toContain('AND queue_kind = $queueKind')
  expect(sql).toContain(
    'ORDER BY priority_bucket DESC, activity_sort_at DESC, article_id DESC, prompt_id DESC, queue_identity DESC',
  )
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
  expect(sql).toContain(
    "ORDER BY CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END ASC, article_id ASC",
  )
  expect(sql).not.toContain('AND list_mode_key =')
})

test('buildReviewServingRowsSql covers judgment detail rows for article details', () => {
  const contract = getRequiredReviewServingReadContract('review.detail.judgments')
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
  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('AND article_id = $articleId')
  expect(sql).toContain("AND payload_kind = 'llm'")
  expect(sql).toContain('QUALIFY CASE list_mode_key')
  expect(sql).toContain('OVER (PARTITION BY prompt_id)')
  expect(sql).toContain('ORDER BY CASE list_mode_key')
  expect(sql).toContain('prompt_order ASC NULLS LAST, prompt_id ASC')
  expect(sql).not.toContain('AND list_mode_key =')
})

test('buildReviewServingRowsSql pins human detail judgment reads to human payloads', () => {
  const sql = buildReviewServingRowsSql({
    articleIdParameter: '$articleId',
    contract: getRequiredReviewServingReadContract('review.detail.humanJudgments'),
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
  expect(sql).toContain("AND payload_kind = 'human'")
  expect(sql).not.toContain('AND list_mode_key =')
})

test('buildReviewServingRowsSql pins fixed list-mode judgment payload reads', () => {
  const humanListSql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract: getRequiredReviewServingReadContract('review.human.list.judgments'),
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
  const bothListSql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract: getRequiredReviewServingReadContract('review.both.list.humanJudgments'),
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

  expect(assertReviewServingSqlShape(humanListSql)).toEqual({ok: true, violations: []})
  expect(assertReviewServingSqlShape(bothListSql)).toEqual({ok: true, violations: []})
  expect(humanListSql).toContain('AND article_id IN (SELECT unnest($articleIds))')
  expect(bothListSql).toContain('AND article_id IN (SELECT unnest($articleIds))')
  expect(humanListSql).toContain("AND list_mode_key = 'human'")
  expect(bothListSql).toContain("AND list_mode_key = 'both'")
  expect(humanListSql).toContain("AND payload_kind = 'human'")
  expect(bothListSql).toContain("AND payload_kind = 'human'")
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
  expect(sql).toContain('AND list_mode_key = $listMode')
  expect(sql).toContain('AND filter_kind = $filterKind AND filter_value = $filterValue')
  expect(sql).toContain('ORDER BY sort_key DESC, article_id ASC')
})

test('buildReviewServingRowsSql intersects posting filters with token-prefix search when requested', () => {
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
    searchTokenPrefixParameter: '$searchTokenPrefix',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('WHERE mart.review_article_filter_posting_serving_v4.project_id = $projectId')
  expect(sql).toContain('AND mart.review_article_filter_posting_serving_v4.snapshot_id = $snapshotId')
  expect(sql).toContain('AND filter_kind = $filterKind AND filter_value = $filterValue')
  expect(sql).toContain('EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search')
  expect(sql).toContain('search.project_id = $projectId')
  expect(sql).toContain('search.search_identity = $searchIdentity')
  expect(sql).toContain('search.project_scope_identity = $projectScopeIdentity')
  expect(sql).toContain('search.snapshot_id = $snapshotId')
  expect(sql).toContain('search.article_id = mart.review_article_filter_posting_serving_v4.article_id')
  expect(sql).toContain('starts_with(search.token, $searchTokenPrefix)')
})

test('buildReviewServingRowsSql rejects foreground multi-filter posting intersections', () => {
  const contract = getRequiredReviewServingReadContract('review.filters.postings')
  const filterPredicatesSql = '(VALUES ($filterKind, $filterValue), ($secondFilterKind, $secondFilterValue))'

  expect(() => {
    buildReviewServingRowsSql({
      contract,
      displayIdentityParameter: '$displayIdentity',
      filterKindParameter: '$filterKind',
      filterPredicatesSql,
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
  }).toThrow('Multi-filter posting intersections require a precomputed serving lookup for review.filters.postings')
})

test('buildReviewServingRowsSql uses contract list-mode literals for fixed row contracts', () => {
  const contract = getRequiredReviewServingReadContract('review.both.rows')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$wrongRuntimeMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(sql).toContain("AND list_mode_key = 'both'")
  expect(sql).not.toContain('$wrongRuntimeMode')
  expect(sql).toContain('ORDER BY sort_key DESC, article_id ASC')
})

test('buildReviewServingRowsSql uses activity ordering for unassessed row contracts', () => {
  const contract = getRequiredReviewServingReadContract('review.unassessed.rows')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$wrongRuntimeMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(sql).toContain("AND list_mode_key = 'unassessed'")
  expect(sql).toContain('EXISTS (SELECT 1 FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(sql).toContain('queue.review_config_hash = $reviewConfigHash')
  expect(sql).toContain('queue.snapshot_id = $snapshotId')
  expect(sql).toContain("queue.queue_kind = 'unassessed'")
  expect(sql).toContain('queue.article_id = mart.review_article_serving_v4.article_id')
  expect(sql).toContain('ORDER BY activity_sort_at DESC, article_id DESC')
  expect(sql).not.toContain('ORDER BY sort_key')
})

test('buildReviewServingRowsSql filters unassessed article-set hydration through queue rows', () => {
  const sql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract: getRequiredReviewServingReadContract('review.unassessed.rowsByArticleSet'),
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$wrongRuntimeMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(sql).toContain('AND article_id IN (SELECT unnest($articleIds))')
  expect(sql).toContain('EXISTS (SELECT 1 FROM mart.review_unassessed_queue_serving_v4 queue')
  expect(sql).toContain("queue.queue_kind = 'unassessed'")
  expect(sql).toContain('queue.article_id = mart.review_article_serving_v4.article_id')
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
  expect(sql).toContain("AND list_mode_key = 'llm'")
  expect(sql).toContain('ORDER BY list_mode_key ASC, count_kind ASC, summary_definition_version ASC, filter_key ASC')
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
    "AND list_mode_key = 'llm' AND count_kind = 'review.llm.assessedByPrompt' AND summary_definition_version = 'review-llm-assessed-by-prompt:v1' AND filter_key = $filterKey",
  )
  expect(sql).not.toContain('$listMode')
})

test('buildReviewServingRowsSql lets count keys override fixed count contract list modes', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.count')
  const sql = buildReviewServingRowsSql({
    contract,
    countFilterKeyParameter: '$filterKey',
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    namedCountKey: 'review.llm.unassessedByPrompt',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain(
    "AND list_mode_key = 'unassessed' AND count_kind = 'review.llm.unassessedByPrompt' AND summary_definition_version = 'review-llm-unassessed-by-prompt:v1' AND filter_key = $filterKey",
  )
  expect(sql).not.toContain("AND list_mode_key = 'llm'")
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
  const jobContract = getRequiredReviewServingReadContract('review.bulk.selection')
  const queueContract = getRequiredReviewServingReadContract('review.queue.unassessed')
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
  expect(() => {
    buildReviewServingRowsSql({...baseParams, contract: queueContract})
  }).toThrow('Missing queue kind for review.queue.unassessed')
  expect(() => {
    buildReviewServingRowsSql({...baseParams, contract: jobContract})
  }).toThrow('Missing job filter signature for review.bulk.selection')
})

test('buildReviewServingRowsSql constrains durable job lookups by criteria', () => {
  const bulkContract = getRequiredReviewServingReadContract('review.bulk.selection')
  const searchContract = getRequiredReviewServingReadContract('review.search.substringAsync')
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
  const bulkSql = buildReviewServingRowsSql({
    ...baseParams,
    contract: bulkContract,
    jobFilterSignatureParameter: '$filterSignature',
  })
  const searchSql = buildReviewServingRowsSql({
    ...baseParams,
    contract: searchContract,
    jobFilterSignatureParameter: '$filterSignature',
    searchTextParameter: '$searchText',
  })

  expect(assertReviewServingSqlShape(bulkSql)).toEqual({ok: true, violations: []})
  expect(bulkSql).toContain('AND review_config_hash IS NOT DISTINCT FROM $reviewConfigHash')
  expect(bulkSql).toContain(
    'AND (snapshot_id = $snapshotId OR (latest_snapshot_semantics = TRUE AND snapshot_id IS NULL))',
  )
  expect(bulkSql).toContain("AND job_kind = 'review.bulk.selection' AND filter_signature = $filterSignature")
  expect(assertReviewServingSqlShape(searchSql, {requireSnapshotScope: false})).toEqual({ok: true, violations: []})
  expect(searchSql).toContain('WHERE project_id = $projectId')
  expect(searchSql).toContain('AND search_identity IS NOT DISTINCT FROM $searchIdentity')
  expect(searchSql).toContain('AND project_scope_identity = $projectScopeIdentity')
  expect(searchSql).toContain('AND review_config_hash IS NOT DISTINCT FROM $reviewConfigHash')
  expect(searchSql).toContain('AND snapshot_id IS NOT DISTINCT FROM $snapshotId')
  expect(searchSql).toContain("AND search_mode = 'substringAsync' AND search_text = $searchText")
  expect(searchSql).toContain('AND filter_signature = $filterSignature')
})

test('buildReviewServingRowsSql supports article-set list judgment lookups', () => {
  const listJudgmentContract = getRequiredReviewServingReadContract('review.both.list.judgments')
  const sql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract: listJudgmentContract,
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
  expect(sql).toContain('AND review_config_hash = $reviewConfigHash')
  expect(sql).toContain('AND snapshot_id = $snapshotId')
  expect(sql).toContain("AND list_mode_key = 'both'")
  expect(sql).toContain("AND payload_kind = 'llm'")
  expect(sql).toContain('AND article_id IN (SELECT unnest($articleIds))')
})

test('buildReviewServingRowsSql supports article-set row hydration lookups', () => {
  const sql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract: getRequiredReviewServingReadContract('review.human.rowsByArticleSet'),
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
  expect(sql).toContain("AND list_mode_key = 'human'")
  expect(sql).toContain('AND article_id IN (SELECT unnest($articleIds))')
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

test('assertReviewServingSqlShape requires real bound scope predicates', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON p.article_id = s.article_id
    WHERE s.project_id = ?
      AND s.snapshot_id = ?
      AND (p.project_id, p.snapshot_id, p.sort_key, p.article_id) < (?, ?, ?, ?)
    ORDER BY p.project_id ASC, p.snapshot_id ASC, p.sort_key DESC, p.article_id DESC
    LIMIT ?
  `
  const violations = getReviewServingSqlShapeViolations(sql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('project scoped read: p')
  expect(violations).toContain('snapshot scoped read: p')
})

test('assertReviewServingSqlShape does not accept scope predicates from qualify clauses', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON p.article_id = s.article_id
    WHERE s.project_id = ? AND s.snapshot_id = ?
    QUALIFY p.project_id = ? AND p.snapshot_id = ?
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `
  const violations = getReviewServingSqlShapeViolations(sql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('project scoped read: p')
  expect(violations).toContain('snapshot scoped read: p')
})

test('assertReviewServingSqlShape rejects literal scope predicates', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_v4 s
    WHERE s.project_id = 'project-1'
      AND s.snapshot_id = 'snapshot-1'
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `
  const violations = getReviewServingSqlShapeViolations(sql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('project scoped read')
  expect(violations).toContain('snapshot scoped read')
})

test('reviewServing read source files are statically guarded without scanning projector or legacy route SQL', () => {
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

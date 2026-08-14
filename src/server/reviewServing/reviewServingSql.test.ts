import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {reviewServingAdjacentRouteClassifications} from './reviewServingAdjacentRouteSurfaces.ts'
import {
  getReviewServingLazyPromptAnswerPostingRowsSql,
  reviewServingPromptAnswerFilterKind,
} from './reviewServingLazyPromptAnswerPostingSql.ts'
import {getReviewServingReadContract} from './reviewServingReadContracts.ts'
import {
  getReviewServingResidualReadMarkers,
  reviewServingResidualReadAllowlist,
} from './reviewServingResidualReadAllowlist.ts'
import {
  assertReviewServingSqlShape,
  buildReviewServingPostingFilterIntersectionArticleCte,
  buildReviewServingRowsSql,
  getReviewServingSqlShapeViolations,
  getReviewServingSqlTableReferences,
  reviewServingRegisteredSqlTables,
} from './reviewServingSql.ts'
import {reviewServingSqlForbiddenPatterns} from './reviewServingSqlForbiddenPatterns.ts'

const reviewServingSourceRoot = import.meta.dir
const sqlGuardDefinitionFile = join(reviewServingSourceRoot, 'reviewServingSqlForbiddenPatterns.ts')
const sqlGuardExcludedFiles = new Set([
  sqlGuardDefinitionFile,
  join(reviewServingSourceRoot, 'reviewServingChunkManifestRepository.ts'),
  join(reviewServingSourceRoot, 'reviewServingRebuildRequestRepository.ts'),
  join(reviewServingSourceRoot, 'reviewServingRetentionService.ts'),
  join(reviewServingSourceRoot, 'reviewServingReviewConfig.ts'),
  join(reviewServingSourceRoot, 'reviewServingDiagnosticsRepository.ts'),
  join(reviewServingSourceRoot, 'reviewServingDirtyWorkService.ts'),
  join(reviewServingSourceRoot, 'reviewServingDynamicCountSql.ts'),
  join(reviewServingSourceRoot, 'reviewServingFilteredCountService.ts'),
  join(reviewServingSourceRoot, 'reviewServingJudgmentJobQueueService.ts'),
  join(reviewServingSourceRoot, 'reviewServingLazyPromptAnswerPostingSql.ts'),
  join(reviewServingSourceRoot, 'reviewServingProjectorDomain.ts'),
  join(reviewServingSourceRoot, 'reviewServingProjectorWriter.ts'),
  join(reviewServingSourceRoot, 'reviewServingResidualReadAllowlist.ts'),
  join(reviewServingSourceRoot, 'reviewServingSql.ts'),
  join(reviewServingSourceRoot, 'reviewServingHumanAssessmentCompletedCount.ts'),
  join(reviewServingSourceRoot, 'reviewServingV4RebuildRequestService.ts'),
])
const reviewServingMaintenanceAdmissionFiles = [
  'reviewServingChunkManifestRepository.ts',
  'reviewServingDirtyWorkService.ts',
  'reviewServingJudgmentJobQueueService.ts',
  'reviewServingProjectorDomain.ts',
  'reviewServingProjectorWriter.ts',
  'reviewServingRebuildRequestRepository.ts',
  'reviewServingV4RebuildRequestService.ts',
] as const
const reviewServingBoundedForegroundAggregationFiles = [
  'reviewServingDynamicCountSql.ts',
  'reviewServingFilteredCountService.ts',
  'reviewServingHumanAssessmentCompletedCount.ts',
  'reviewServingLazyPromptAnswerPostingSql.ts',
  'reviewServingSql.ts',
] as const
const workspaceRoot = process.cwd()

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
      && !sqlGuardExcludedFiles.has(filePath)
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
  expect(sql).not.toContain('INNER JOIN mart.review_article_serving_payload_v4 payload')
  expect(sql).not.toContain('payload.display_identity = $displayIdentity')
  expect(sql).not.toContain('payload.payload_identity = $payloadIdentity')
  expect(sql).toContain('COALESCE(selected_hot.article_title, article.article_title) AS article_title')
  expect(sql).toContain('COALESCE(selected_hot.external_id, article.article_id) AS article_external_id')
  expect(sql).toContain('selected_hot.journal_title AS journal_title')
  expect(sql).toContain(
    "COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url",
  )
  expect(sql).toContain('article.full_text_pdf AS full_text_pdf')
  expect(sql).toContain('article.full_text_conversion_status AS full_text_conversion_status')
  expect(sql).toContain('selected_import.import_route_id AS selected_import_route_id')
  expect(sql).not.toContain('serving_updated_at')
  expect(sql).toContain('LEFT JOIN mart.review_selected_article_import_current_v4 selected_import')
  expect(sql).toContain('selected_import.project_id = $projectId')
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain('list_mode_state.has_llm_list_mode IS TRUE')
  expect(sql).toContain('list_mode_state.llm_patch_watermark AS patch_watermark')
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
  expect(sql).toContain('selected_import.project_id = serving.project_id')
  expect(sql).toContain('selected_import.project_scope_identity = $projectScopeIdentity')
  expect(sql).toContain('selected_import.selected_import_snapshot_id = $selectedImportSnapshotId')
  expect(sql).toContain('selected_import.article_id = serving.article_id')
  expect(sql).toContain('AND NOT selected_import.tombstone')
  expect(sql).toContain('LEFT JOIN app.article article ON article.id = serving.article_id')
  expect(sql).toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(sql).toContain('selected_hot.import_route_id = selected_import.import_route_id')
  expect(sql).toContain('selected_hot.source_record_key = selected_import.source_record_key')
  expect(sql).toContain('AND NOT selected_hot.tombstone')
  expect(sql).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(sql).toContain('json_merge_patch')
  expect(sql).not.toContain('mart.review_article_serving_v4.article_title AS article_title')
  expect(sql).not.toContain('mart.review_article_serving_v4.selected_import_route_id')
  expect(sql).not.toContain('payload.display_identity = mart.review_article_serving_v4.display_identity')
  expect(sql).not.toContain('payload.payload_identity = mart.review_article_serving_v4.payload_identity')
  expect(sql).toContain('WHERE serving.project_id = $projectId AND serving.review_config_hash = $reviewConfigHash')
  expect(sql).toContain('AND serving.snapshot_id = $snapshotId')
})

test('article serving read and projector SQL do not reference serving updated-at', () => {
  const retiredColumn = 'serving_' + 'updated_at'
  const guardedFiles = [
    'reviewServingSql.ts',
    'reviewServingDisplayPayloadProjector.ts',
    'reviewServingSelectedImportProjector.ts',
    'reviewServingSelectedImportDirtyProjector.ts',
    'reviewServingLlmStatusProjector.ts',
    'reviewServingHumanStatusProjector.ts',
  ]

  expect(
    guardedFiles.flatMap((fileName) => {
      const source = readFileSync(join(reviewServingSourceRoot, fileName), 'utf8')

      return source.includes(retiredColumn) ? [fileName] : []
    }),
  ).toEqual([])
})

test('buildReviewServingRowsSql uses article ordering and payload hydration for prompt preview', () => {
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
  expect(sql).not.toContain('INNER JOIN mart.review_article_serving_payload_v4 payload')
  expect(sql).not.toContain('payload.display_identity = $displayIdentity')
  expect(sql).not.toContain('payload.payload_identity = $payloadIdentity')
  expect(sql).toContain('LEFT(article.article_summary, 2000) AS article_summary')
  expect(sql).not.toContain('payload.abstract_text')
  expect(sql).toContain('COALESCE(selected_hot.article_title, article.article_title) AS article_title')
  expect(sql).toContain('COALESCE(selected_hot.external_id, article.article_id) AS article_external_id')
  expect(sql).toContain('article.article_updated_at AS article_updated_at')
  expect(sql).toContain('article.arxiv_id AS arxiv_id')
  expect(sql).toContain('article.biorxiv_id AS biorxiv_id')
  expect(sql).toContain('article.medrxiv_id AS medrxiv_id')
  expect(sql).toContain('article.doi AS doi')
  expect(sql).toContain('article.pubmed_id AS pmid')
  expect(sql).toContain(
    "COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url",
  )
  expect(sql).toContain('article.full_text_pdf AS full_text_pdf')
  expect(sql).toContain('article.full_text_fetched_at AS full_text_fetched_at')
  expect(sql).toContain('article.full_text_conversion_status AS full_text_conversion_status')
  expect(sql).toContain('article.source_metadata')
  expect(sql).toContain('selected_source.import_metadata')
  expect(sql).toContain('json_merge_patch')
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain("('both', list_mode_state.has_both_list_mode)")
  expect(sql).toContain("('llm', list_mode_state.has_llm_list_mode)")
  expect(sql).toContain("('human', list_mode_state.has_human_list_mode)")
  expect(sql).toContain("('unassessed', list_mode_state.has_unassessed_list_mode)")
  expect(sql).toContain('AS list_mode(list_mode_key, has_list_mode)')
  expect(sql).toContain('list_mode.has_list_mode IS TRUE')
  expect(sql).not.toContain('list_mode_state.list_mode_keys')
  expect(sql).toContain('LEFT JOIN app.article article ON article.id = serving.article_id')
  expect(sql).toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(sql).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(sql).not.toContain('payload.full_text_preview')
  expect(sql).toContain('WHERE serving.project_id = $projectId AND serving.review_config_hash = $reviewConfigHash')
  expect(sql).toContain('AND serving.snapshot_id = $snapshotId')
  expect(sql).toContain(
    "QUALIFY CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END = min(CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END) OVER (PARTITION BY serving.article_id)",
  )
  expect(sql).toContain(
    "ORDER BY serving.article_created_at ASC NULLS LAST, article_id ASC, CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END ASC",
  )
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
  expect(sql).not.toContain('JOIN mart.review_article_serving_v4')
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
    'WHERE mart.review_title_search_serving_v4.project_id = $projectId AND search_identity = $searchIdentity AND project_scope_identity = $projectScopeIdentity AND snapshot_id = $snapshotId',
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
    'WHERE mart.review_filter_option_serving_v4.project_id = $projectId AND review_config_hash = $reviewConfigHash AND snapshot_id = $snapshotId AND search_identity = $searchIdentity AND filter_option_identity = $filterOptionIdentity',
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
  expect(reviewSql).toContain(
    "CASE WHEN mart.review_filter_facet_serving_v4.availability = 'ready' THEN mart.review_filter_facet_serving_v4.count_value ELSE NULL END AS count_value",
  )
  expect(reviewSql).toContain('AND summary_definition_version IN (')
  expect(reviewSql).toContain("'review-filter-duplicate-flag:v1'")
  expect(reviewSql).toContain("'review-filter-import-route:v1'")
  expect(reviewSql).toContain("'review-filter-prompt-answer:v1'")
  expect(reviewSql).toContain("'review-filter-publication-year:v1'")
  expect(reviewSql).toContain('AND summary_identity = $filterKey')
  expect(humanSql).toContain("AND facet_kind = 'human'")
  expect(humanSql).toContain(
    "CASE WHEN mart.review_filter_facet_serving_v4.availability = 'ready' THEN mart.review_filter_facet_serving_v4.count_value ELSE NULL END AS count_value",
  )
  expect(humanSql).toContain('AND summary_definition_version IN (')
  expect(humanSql).toContain("'review-human-filter-prompt-answer:v1'")
  expect(humanSql).toContain("'review-human-filter-summary-answer:v1'")
  expect(humanSql).toContain('AND summary_identity = $filterKey')
})

test('buildReviewServingRowsSql supports batched facet identities', () => {
  const contract = getRequiredReviewServingReadContract('review.filters.facets')
  const sql = buildReviewServingRowsSql({
    contract,
    countFilterKeysParameter: '$filterKeys',
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
  expect(sql).toContain('AND summary_identity IN (SELECT unnest($filterKeys))')
  expect(sql).not.toContain('AND summary_identity = $filterKey')
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
    "WHERE app.review_serving_snapshot_manifest.project_id = $projectId AND review_config_hash IS NOT DISTINCT FROM $reviewConfigHash AND snapshot_status IN ('active', 'retired') ORDER BY updated_at DESC, snapshot_id DESC",
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
    'WHERE mart.review_unassessed_queue_article_rank_serving_v4.project_id = $projectId AND review_config_hash = $reviewConfigHash AND mart.review_unassessed_queue_article_rank_serving_v4.snapshot_id = $snapshotId',
  )
  expect(sql).not.toContain('list_mode_key')
  expect(sql).toContain('AND queue_kind = $queueKind')
  expect(sql).toContain('ORDER BY priority_bucket DESC, activity_sort_at DESC, article_id DESC')
  expect(sql).not.toContain('prompt_id DESC')
  expect(sql).not.toContain('sort_key')
})

test('buildReviewServingRowsSql applies queue article date filters through article serving base', () => {
  const contract = getRequiredReviewServingReadContract('review.queue.unassessed')
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    filterPredicatesSql:
      ' AND queue_article.article_created_at >= TIMESTAMPTZ $articleCreatedAtFrom AND queue_article.article_created_at <= TIMESTAMPTZ $articleCreatedAtTo',
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
  expect(sql).toContain('INNER JOIN mart.review_article_serving_base_v4 queue_article')
  expect(sql).toContain('queue_article.article_created_at >= TIMESTAMPTZ $articleCreatedAtFrom')
  expect(sql).toContain('queue_article.article_created_at <= TIMESTAMPTZ $articleCreatedAtTo')
  expect(sql).not.toContain('mart.review_unassessed_queue_article_rank_serving_v4.article_created_at')
})

test('buildReviewServingRowsSql requires all token prefixes for queue search', () => {
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
    searchTokenPrefixParameter: '$searchTokenPrefix',
    searchTokenPrefixesParameter: '$searchTokenPrefixes',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('AND queue_kind = $queueKind')
  expect(sql).toContain('search_prefixes AS')
  expect(sql).toContain('search_candidate_article_ids AS')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 search_candidate_queue')
  expect(sql).toContain('search_candidate_queue.queue_kind = $queueKind')
  expect(sql).toContain('expanded_search_article_ids AS')
  expect(sql).toContain('search_filtered_article_ids AS')
  expect(sql).toContain('SELECT unnest($searchTokenPrefixes) AS token_prefix')
  expect(sql.indexOf('search_candidate_article_ids AS')).toBeLessThan(sql.indexOf('expanded_search_article_ids AS'))
  expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM search_prefixes required_search_prefix')
  expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM expanded_search_article_ids matched_search_article')
  expect(sql).toContain('(NOT EXISTS (SELECT 1 FROM search_prefixes) OR EXISTS')
  expect(sql).toContain('starts_with(search.token, search_prefix.token_prefix)')
  expect(sql).toContain(
    'FROM search_candidate_article_ids search_candidate_article JOIN mart.review_title_search_serving_v4 search ON list_contains(search.article_ids, search_candidate_article.article_id)',
  )
  expect(sql).not.toContain('CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)')
  expect(sql).not.toContain('starts_with(search.token, $searchTokenPrefix)')
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
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain("('both', list_mode_state.has_both_list_mode)")
  expect(sql).toContain("('llm', list_mode_state.has_llm_list_mode)")
  expect(sql).toContain("('human', list_mode_state.has_human_list_mode)")
  expect(sql).toContain("('unassessed', list_mode_state.has_unassessed_list_mode)")
  expect(sql).toContain('AS list_mode(list_mode_key, has_list_mode)')
  expect(sql).toContain('list_mode.has_list_mode IS TRUE')
  expect(sql).not.toContain('list_mode_state.list_mode_keys')
  expect(sql).toContain('AND serving.article_id = $articleId')
  expect(sql).toContain('article.source_metadata')
  expect(sql).toContain('selected_source.import_metadata')
  expect(sql).toContain('json_merge_patch')
  expect(sql).toContain('END AS source_metadata')
  expect(sql).toContain(
    "CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END AS list_mode_priority",
  )
  expect(sql).not.toContain('payload.source_metadata')
  expect(sql).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(sql).toContain('SELECT serving.project_id')
  expect(sql).not.toContain('mart.review_article_serving_v4.*')
  expect(sql).toContain(
    "ORDER BY CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END ASC, article_id ASC",
  )
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
  expect(sql).not.toContain('JOIN mart.review_article_serving_v4')
  expect(sql).not.toContain('AND list_mode_key =')
})

test('direct article reads expand list modes from flags instead of stale list keys in DuckDB', async () => {
  const contract = getRequiredReviewServingReadContract('review.detail.row')
  const getSql = (articleId: string) => {
    return buildReviewServingRowsSql({
      articleIdParameter: `'${articleId}'`,
      contract,
      displayIdentityParameter: "'display-1'",
      limitParameter: '10',
      listModeParameter: "'llm'",
      payloadIdentityParameter: "'payload-1'",
      projectIdParameter: "'project-1'",
      projectScopeIdentityParameter: "'scope-1'",
      reviewConfigHashParameter: "'review-config-1'",
      searchIdentityParameter: "'search-1'",
      selectedImportSnapshotIdParameter: "'selected-import-snapshot-1'",
      snapshotIdParameter: "'snapshot-1'",
    })
  }
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE SCHEMA app;
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        base_generation INTEGER,
        article_id VARCHAR,
        article_created_at TIMESTAMP,
        sort_key VARCHAR,
        activity_sort_at TIMESTAMP
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        list_mode_keys VARCHAR[],
        has_llm_list_mode BOOLEAN,
        has_human_list_mode BOOLEAN,
        has_both_list_mode BOOLEAN,
        has_unassessed_list_mode BOOLEAN,
        llm_patch_watermark INTEGER,
        human_patch_watermark INTEGER,
        both_patch_watermark INTEGER,
        unassessed_patch_watermark INTEGER
      );
      CREATE TABLE mart.review_selected_article_import_current_v4 (
        project_id VARCHAR,
        project_scope_identity VARCHAR,
        selected_import_snapshot_id VARCHAR,
        article_id VARCHAR,
        import_route_id VARCHAR,
        source_record_key VARCHAR,
        tombstone BOOLEAN
      );
      CREATE TABLE app.article (
        id VARCHAR,
        article_id VARCHAR,
        article_title VARCHAR,
        article_updated_at TIMESTAMP,
        arxiv_id VARCHAR,
        biorxiv_id VARCHAR,
        medrxiv_id VARCHAR,
        doi VARCHAR,
        pubmed_id VARCHAR,
        url VARCHAR,
        full_text_pdf VARCHAR,
        full_text_fetched_at TIMESTAMP,
        full_text_conversion_status VARCHAR,
        source_metadata JSON
      );
      CREATE TABLE app.review_import_article_hot_field (
        import_route_id VARCHAR,
        article_id VARCHAR,
        source_record_key VARCHAR,
        article_title VARCHAR,
        external_id VARCHAR,
        journal_title VARCHAR,
        tombstone BOOLEAN
      );
      CREATE TABLE app.article_import_route_source_record (
        import_route_id VARCHAR,
        article_id VARCHAR,
        source_record_key VARCHAR,
        raw_payload JSON,
        import_metadata JSON,
        quarantined_at TIMESTAMP
      );
      INSERT INTO mart.review_article_serving_base_v4 VALUES
      (
        'project-1',
        'review-config-1',
        'snapshot-1',
        7,
        'article-1',
        TIMESTAMP '2026-01-01 00:00:00',
        'sort-1',
        TIMESTAMP '2026-01-01 00:00:00'
      ),
      (
        'project-1',
        'review-config-1',
        'snapshot-1',
        7,
        'article-2',
        TIMESTAMP '2026-01-03 00:00:00',
        'sort-2',
        TIMESTAMP '2026-01-03 00:00:00'
      );
      INSERT INTO mart.review_article_serving_list_mode_state_v4 VALUES
      (
        'project-1',
        'review-config-1',
        'snapshot-1',
        'article-1',
        ['llm'],
        FALSE,
        TRUE,
        FALSE,
        FALSE,
        11,
        22,
        33,
        44
      ),
      (
        'project-1',
        'review-config-1',
        'snapshot-1',
        'article-2',
        ['unassessed'],
        TRUE,
        TRUE,
        TRUE,
        FALSE,
        111,
        222,
        333,
        444
      );
      INSERT INTO app.article VALUES
      (
        'article-1',
        'external-article-1',
        'Article 1',
        TIMESTAMP '2026-01-02 00:00:00',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      ),
      (
        'article-2',
        'external-article-2',
        'Article 2',
        TIMESTAMP '2026-01-04 00:00:00',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      );
    `)

    const staleArrayReader = await connection.runAndReadAll(getSql('article-1'))
    const staleArrayRows = staleArrayReader.getRowObjectsJson() as Array<{
      list_mode_key: string
      patch_watermark: number
    }>

    expect(staleArrayRows).toHaveLength(1)
    expect(staleArrayRows[0]?.list_mode_key).toBe('human')
    expect(staleArrayRows[0]?.patch_watermark).toBe(22)

    const priorityReader = await connection.runAndReadAll(getSql('article-2'))
    const priorityRows = priorityReader.getRowObjectsJson() as Array<{list_mode_key: string; patch_watermark: number}>

    expect(
      priorityRows.map((row) => {
        return {listModeKey: row.list_mode_key, patchWatermark: row.patch_watermark}
      }),
    ).toEqual([
      {listModeKey: 'both', patchWatermark: 333},
      {listModeKey: 'llm', patchWatermark: 111},
      {listModeKey: 'human', patchWatermark: 222},
    ])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
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
  expect(sql).toContain('SELECT mart.review_article_judgment_detail_serving_v4.project_id')
  expect(sql).toContain('llm_judgment.model_id AS judgment_model_id')
  expect(sql).toContain('llm_judgment.explanation AS explanation')
  expect(sql).toContain('llm_judgment.quotes AS quotes')
  expect(sql).not.toContain('mart.review_article_judgment_detail_hydration_serving_v4')
  expect(sql).toContain('LEFT JOIN app."judgment" llm_judgment')
  expect(sql).toContain('llm_judgment.id = mart.review_article_judgment_detail_serving_v4.judgment_id')
  expect(sql).toContain('llm_judgment.article_id = mart.review_article_judgment_detail_serving_v4.article_id')
  expect(sql).toContain('llm_judgment.prompt_id = mart.review_article_judgment_detail_serving_v4.prompt_id')
  expect(sql).toContain('llm_judgment.deleted_at IS NULL')
  expect(sql).toContain('LEFT JOIN app.judgment_assessment assessment')
  expect(sql).toContain('FROM app.judgment_assessment latest_assessment')
  expect(sql).toContain('WHERE latest_assessment.judgment_id = llm_judgment.id')
  expect(sql).toContain('LEFT JOIN app.model model')
  expect(sql).toContain('LEFT JOIN app.provider_connection provider_connection')
  expect(sql).toContain(
    'COALESCE(llm_judgment.updated_at, human_judgment.updated_at, human_summary.updated_at) AS judgment_updated_at',
  )
  expect(sql).toContain('llm_judgment.confidence_original AS confidence_original')
  expect(sql).toContain(
    'COALESCE(model.display_name, model.name, llm_judgment.snapshot_project_model_name) AS model_name',
  )
  expect(sql).toContain("json_extract_string(model.metadata_json, '$.options.thinking') AS model_thinking")
  expect(sql).toContain('assessment.id AS assessment_id')
  expect(sql).toContain('assessment.updated_at AS assessment_updated_at')
  expect(sql).toContain('LEFT JOIN app."judgment_human" human_judgment')
  expect(sql).toContain('LEFT JOIN app."judgment_human_summary" human_summary')
  expect(sql).toContain('LEFT JOIN app.project_prompt project_prompt')
  expect(sql).toContain('project_prompt.prompt_id = mart.review_article_judgment_detail_serving_v4.prompt_id')
  expect(sql).toContain('LEFT JOIN app.prompt prompt')
  expect(sql).toContain('prompt.id = mart.review_article_judgment_detail_serving_v4.prompt_id')
  expect(sql).toContain('ELSE prompt.original_text END AS prompt_original_text')
  expect(sql).toContain('ELSE prompt.prompt_heading END AS prompt_heading')
  expect(sql).toContain('ELSE prompt.type END AS prompt_type')
  expect(sql).toContain('ELSE project_prompt.criteria_disposition END AS prompt_criteria_disposition')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.judgment_updated_at')
  expect(sql).not.toContain('judgment_payload_json')
  expect(sql).toContain(
    "CASE mart.review_article_judgment_detail_serving_v4.payload_kind WHEN 'llm' THEN 1 WHEN 'human' THEN 2 ELSE 4 END AS list_mode_priority",
  )
  expect(sql).toContain('AND mart.review_article_judgment_detail_serving_v4.review_config_hash = $reviewConfigHash')
  expect(sql).toContain('AND mart.review_article_judgment_detail_serving_v4.article_id = $articleId')
  expect(sql).toContain("AND mart.review_article_judgment_detail_serving_v4.payload_kind = 'llm'")
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.placeholder_kind IS NULL')
  expect(sql).not.toContain('QUALIFY CASE mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('ORDER BY CASE mart.review_article_judgment_detail_serving_v4.payload_kind')
  expect(sql).toContain(
    'mart.review_article_judgment_detail_serving_v4.prompt_order ASC NULLS LAST, mart.review_article_judgment_detail_serving_v4.prompt_id ASC',
  )
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
  expect(sql).toContain('AND mart.review_article_judgment_detail_serving_v4.article_id = $articleId')
  expect(sql).toContain("AND mart.review_article_judgment_detail_serving_v4.payload_kind = 'human'")
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.placeholder_kind IS NULL')
  expect(sql).not.toContain('AND list_mode_key =')
  expect(sql).not.toContain('judgment_payload_json')
})

test('buildReviewServingRowsSql excludes placeholder rows only for LLM list judgment reads', () => {
  const buildSql = (contractKey: string) => {
    return buildReviewServingRowsSql({
      articleIdsParameter: '$articleIds',
      contract: getRequiredReviewServingReadContract(contractKey),
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
  }
  const placeholderPredicate = 'AND mart.review_article_judgment_detail_serving_v4.placeholder_kind IS NULL'

  const llmListSql = buildSql('review.llm.list.judgments')
  const bothListSql = buildSql('review.both.list.judgments')
  const humanListSql = buildSql('review.human.list.judgments')
  const bothHumanListSql = buildSql('review.both.list.humanJudgments')

  expect(assertReviewServingSqlShape(llmListSql)).toEqual({ok: true, violations: []})
  expect(assertReviewServingSqlShape(bothListSql)).toEqual({ok: true, violations: []})
  expect(assertReviewServingSqlShape(humanListSql)).toEqual({ok: true, violations: []})
  expect(assertReviewServingSqlShape(bothHumanListSql)).toEqual({ok: true, violations: []})
  expect(llmListSql).toContain(placeholderPredicate)
  expect(bothListSql).toContain(placeholderPredicate)
  expect(humanListSql).not.toContain(placeholderPredicate)
  expect(bothHumanListSql).not.toContain(placeholderPredicate)
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
  expect(humanListSql).toContain(
    'AND mart.review_article_judgment_detail_serving_v4.article_id IN (SELECT unnest($articleIds))',
  )
  expect(bothListSql).toContain(
    'AND mart.review_article_judgment_detail_serving_v4.article_id IN (SELECT unnest($articleIds))',
  )
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.list_mode_key')
  expect(bothListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.list_mode_key')
  expect(bothListSql).toContain("'both' AS list_mode_key")
  expect(humanListSql).toContain("AND mart.review_article_judgment_detail_serving_v4.payload_kind = 'human'")
  expect(bothListSql).toContain("AND mart.review_article_judgment_detail_serving_v4.payload_kind = 'human'")
  expect(humanListSql).toContain('NULL AS judgment_model_id')
  expect(humanListSql).toContain('NULL AS explanation')
  expect(humanListSql).toContain('NULL AS quotes')
  expect(humanListSql).not.toContain('llm_judgment.model_id AS judgment_model_id')
  expect(humanListSql).not.toContain('llm_judgment.explanation AS explanation')
  expect(humanListSql).not.toContain('llm_judgment.quotes AS quotes')
  expect(humanListSql).not.toContain('LEFT JOIN app."judgment" llm_judgment')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.judgment_model_id')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.explanation')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.quotes')
  expect(humanListSql).toContain('mart.review_article_judgment_detail_serving_v4.human_comment')
  expect(humanListSql).toContain('mart.review_article_judgment_detail_serving_v4.detail_updated_at')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.is_answered')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.prompt_original_text')
  expect(humanListSql).not.toContain('JOIN app.project_prompt')
  expect(humanListSql).not.toContain('JOIN app.prompt')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.judgment_updated_at')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.confidence_original')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.model_provider')
  expect(humanListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.assessment_id')
  expect(humanListSql).not.toContain('SELECT *')
  expect(humanListSql).not.toContain('judgment_payload_json')
  expect(bothListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.judgment_updated_at')
  expect(bothListSql).not.toContain('mart.review_article_judgment_detail_serving_v4.assessment_id')
  expect(bothListSql).not.toContain('SELECT *')
  expect(bothListSql).not.toContain('judgment_payload_json')
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
  expect(sql).toContain('AND mart.review_article_filter_posting_serving_v4.list_mode_key = $listMode')
  expect(sql).toContain('AND filter_kind = $filterKind AND filter_value = $filterValue')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_base_v4 serving_order')
  expect(sql).not.toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 serving_order_state')
  expect(sql).not.toContain('list_contains(serving_order_state.list_mode_keys')
  expect(sql).not.toContain('INNER JOIN mart.review_article_serving_v4')
  expect(sql).toContain(
    'CROSS JOIN UNNEST(mart.review_article_filter_posting_serving_v4.article_ids) AS filter_posting_article(article_id)',
  )
  expect(sql).toContain('serving_order.article_id = filter_posting_article.article_id')
  expect(sql).toContain('ORDER BY serving_order.sort_key DESC, serving_order.article_id ASC')
})

test('buildReviewServingRowsSql uses one anchored posting CTE for ordered-prefix multi-filter rows', () => {
  const contract = getRequiredReviewServingReadContract('review.llm.rows')
  const postingFilterCte = buildReviewServingPostingFilterIntersectionArticleCte({
    groups: [
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
      {filterKind: 'promptAnswer', filterValues: ['review:promptAnswer:prompt-1:yes']},
    ],
    listModeSql: "'llm'",
    projectIdSql: '$projectId',
    reviewConfigHashSql: '$reviewConfigHash',
    snapshotIdSql: '$snapshotId',
  })
  const sql = buildReviewServingRowsSql({
    contract,
    displayIdentityParameter: '$displayIdentity',
    filterPredicatesSql:
      ' AND EXISTS (SELECT 1 FROM posting_filtered_article_ids WHERE posting_filtered_article_ids.article_id = serving.article_id)',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    selectedImportSnapshotIdParameter: '$selectedImportSnapshotId',
    snapshotIdParameter: '$snapshotId',
    withCtesSql: postingFilterCte,
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('WITH matched_posting_rows AS')
  expect(sql).toContain('posting_anchor_rows AS')
  expect(sql).toContain('posting_filtered_article_ids AS')
  expect(sql).toContain('SELECT posting.article_ids, posting.filter_kind, posting.filter_value')
  expect(sql).toContain('FROM mart.review_article_filter_posting_serving_v4 posting')
  expect(sql.indexOf('WHERE posting.project_id = $projectId')).toBeLessThan(
    sql.indexOf('CROSS JOIN UNNEST(anchor.article_ids) AS anchor_article(article_id)'),
  )
  expect(sql).toContain("posting.filter_kind = 'importRoute'")
  expect(sql).toContain("posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[]))")
  expect(sql).toContain("posting.filter_kind = 'promptAnswer'")
  expect(sql).toContain("posting.filter_value IN (SELECT unnest(['review:promptAnswer:prompt-1:yes']::VARCHAR[]))")
  expect(sql).toContain('SUM(array_length(posting.article_ids)) OVER (PARTITION BY CASE')
  expect(sql).toContain('matched_group_article_id_count')
  expect(sql).toContain('FROM matched_posting_rows smaller_anchor_group')
  expect(sql).toContain('posting_anchor_group AS')
  expect(sql).toContain('posting_candidate_article_groups AS')
  expect(sql).toContain('CROSS JOIN posting_anchor_group anchor_group')
  expect(sql).toContain('CROSS JOIN UNNEST(candidate.article_ids) AS candidate_article(article_id)')
  expect(sql).toContain('CROSS JOIN UNNEST(anchor.article_ids) AS anchor_article(article_id)')
  expect(sql).toContain('candidate.article_id = anchor_article.article_id')
  expect(sql).toContain('FROM (VALUES (0), (1)) AS required_posting_group(required_group_index)')
  expect(sql).toContain('SELECT DISTINCT anchor_article.article_id')
  expect(sql).not.toContain('list_contains(candidate.article_ids, anchor_article.article_id)')
  expect(sql).not.toContain('CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)')
  expect(sql).not.toContain('GROUP BY posting_article.article_id')
  expect(sql).not.toContain('HAVING COUNT(DISTINCT CASE')
  expect(sql).not.toContain('ORDER BY array_length(anchor.article_ids)')
  expect(sql).toContain(
    'EXISTS (SELECT 1 FROM posting_filtered_article_ids WHERE posting_filtered_article_ids.article_id = serving.article_id)',
  )
  expect(sql).not.toContain('filter_4_articles AS')
  expect(sql).not.toContain('filter_5_articles AS')
  expect(sql.match(/CROSS JOIN UNNEST\(filter_\d+\.article_ids\)/gu)?.length ?? 0).toBe(0)
})

test('posting filter intersection CTE keeps single posting group on the direct posting expansion path', () => {
  const cte = buildReviewServingPostingFilterIntersectionArticleCte({
    groups: [{filterKind: 'importRoute', filterValues: ['import-route-1', 'import-route-2']}],
    listModeSql: "'llm'",
    projectIdSql: '$projectId',
    reviewConfigHashSql: '$reviewConfigHash',
    snapshotIdSql: '$snapshotId',
  })

  expect(cte).toContain('SELECT DISTINCT posting_article.article_id')
  expect(cte).toContain('CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)')
  expect(cte).toContain("posting.filter_value IN (SELECT unnest(['import-route-1', 'import-route-2']::VARCHAR[]))")
  expect(cte).not.toContain('matched_posting_rows AS')
  expect(cte).not.toContain('posting_candidate_article_groups AS')
  expect(cte).not.toContain('CROSS JOIN UNNEST(candidate.article_ids)')
})

test('posting filter intersection CTE matches legacy group-by semantics in DuckDB', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        list_mode_key VARCHAR,
        filter_kind VARCHAR,
        filter_value VARCHAR,
        article_ids VARCHAR[]
      );
      INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-1', 'article-2']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-3', 'article-4']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'population', 'adult', ['article-2', 'article-3']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'population', 'pediatric', ['article-3', 'article-4', 'article-5']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'promptAnswer', 'yes', ['article-3']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'promptAnswer', 'yes', ['article-4']),
        ('project-1', 'review-config-1', 'snapshot-1', 'human', 'importRoute', 'import-route-1', ['article-3']),
        ('project-1', 'review-config-1', 'snapshot-other', 'llm', 'importRoute', 'import-route-1', ['article-5']);
    `)

    const groups = [
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
      {filterKind: 'population', filterValues: ['adult', 'adult', 'pediatric']},
      {filterKind: 'promptAnswer', filterValues: ['yes']},
    ]
    const optimizedCte = buildReviewServingPostingFilterIntersectionArticleCte({
      groups,
      listModeSql: "'llm'",
      projectIdSql: "'project-1'",
      reviewConfigHashSql: "'review-config-1'",
      snapshotIdSql: "'snapshot-1'",
    })
    const legacyCte = `
      posting_filtered_article_ids AS (
        SELECT posting_article.article_id
        FROM (
          SELECT posting.article_ids, posting.filter_kind, posting.filter_value
          FROM mart.review_article_filter_posting_serving_v4 posting
          WHERE posting.project_id = 'project-1'
            AND posting.snapshot_id = 'snapshot-1'
            AND posting.review_config_hash = 'review-config-1'
            AND posting.list_mode_key = 'llm'
            AND (
              (posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])))
              OR (posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult', 'adult', 'pediatric']::VARCHAR[])))
              OR (posting.filter_kind = 'promptAnswer' AND posting.filter_value IN (SELECT unnest(['yes']::VARCHAR[])))
            )
        ) posting
        CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)
        GROUP BY posting_article.article_id
        HAVING COUNT(DISTINCT CASE
          WHEN posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])) THEN 0
          WHEN posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult', 'adult', 'pediatric']::VARCHAR[])) THEN 1
          WHEN posting.filter_kind = 'promptAnswer' AND posting.filter_value IN (SELECT unnest(['yes']::VARCHAR[])) THEN 2
        END) = 3
      )
    `
    const optimizedReader = await connection.runAndReadAll(
      `WITH ${optimizedCte} SELECT article_id FROM posting_filtered_article_ids ORDER BY article_id`,
    )
    const legacyReader = await connection.runAndReadAll(
      `WITH ${legacyCte} SELECT article_id FROM posting_filtered_article_ids ORDER BY article_id`,
    )

    expect(optimizedReader.getRowObjectsJson()).toEqual(legacyReader.getRowObjectsJson())
    expect(optimizedReader.getRowObjectsJson()).toEqual([{article_id: 'article-3'}, {article_id: 'article-4'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('posting filter intersection CTE matches legacy semantics when anchor groups tie', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        list_mode_key VARCHAR,
        filter_kind VARCHAR,
        filter_value VARCHAR,
        article_ids VARCHAR[]
      );
      INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-1', 'article-2']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'population', 'adult', ['article-2', 'article-3']);
    `)

    const groups = [
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
      {filterKind: 'population', filterValues: ['adult']},
    ]
    const optimizedCte = buildReviewServingPostingFilterIntersectionArticleCte({
      groups,
      listModeSql: "'llm'",
      projectIdSql: "'project-1'",
      reviewConfigHashSql: "'review-config-1'",
      snapshotIdSql: "'snapshot-1'",
    })
    const legacyCte = `
      posting_filtered_article_ids AS (
        SELECT posting_article.article_id
        FROM (
          SELECT posting.article_ids, posting.filter_kind, posting.filter_value
          FROM mart.review_article_filter_posting_serving_v4 posting
          WHERE posting.project_id = 'project-1'
            AND posting.snapshot_id = 'snapshot-1'
            AND posting.review_config_hash = 'review-config-1'
            AND posting.list_mode_key = 'llm'
            AND (
              (posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])))
              OR (posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult']::VARCHAR[])))
            )
        ) posting
        CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)
        GROUP BY posting_article.article_id
        HAVING COUNT(DISTINCT CASE
          WHEN posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])) THEN 0
          WHEN posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult']::VARCHAR[])) THEN 1
        END) = 2
      )
    `
    const optimizedReader = await connection.runAndReadAll(
      `WITH ${optimizedCte} SELECT article_id FROM posting_filtered_article_ids ORDER BY article_id`,
    )
    const legacyReader = await connection.runAndReadAll(
      `WITH ${legacyCte} SELECT article_id FROM posting_filtered_article_ids ORDER BY article_id`,
    )

    expect(optimizedReader.getRowObjectsJson()).toEqual(legacyReader.getRowObjectsJson())
    expect(optimizedReader.getRowObjectsJson()).toEqual([{article_id: 'article-2'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
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
  expect(sql).toContain('search_prefixes AS (SELECT $searchTokenPrefix AS token_prefix)')
  expect(sql).toContain('search_candidate_article_ids AS')
  expect(sql).toContain('FROM mart.review_article_filter_posting_serving_v4 search_candidate_posting')
  expect(sql).toContain(
    'CROSS JOIN UNNEST(search_candidate_posting.article_ids) AS search_candidate_article(article_id)',
  )
  expect(sql).toContain('search_candidate_posting.filter_kind = $filterKind')
  expect(sql).toContain('search_candidate_posting.filter_value = $filterValue')
  expect(sql).toContain('expanded_search_article_ids AS')
  expect(sql).toContain('search_filtered_article_ids AS')
  expect(sql.indexOf('search_candidate_article_ids AS')).toBeLessThan(sql.indexOf('expanded_search_article_ids AS'))
  expect(sql).toContain('search.project_id = $projectId')
  expect(sql).toContain('search.search_identity = $searchIdentity')
  expect(sql).toContain('search.project_scope_identity = $projectScopeIdentity')
  expect(sql).toContain('search.snapshot_id = $snapshotId')
  expect(sql).toContain(
    'FROM search_candidate_article_ids search_candidate_article JOIN mart.review_title_search_serving_v4 search ON list_contains(search.article_ids, search_candidate_article.article_id)',
  )
  expect(sql).not.toContain('CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)')
  expect(sql).toContain('EXISTS (SELECT 1 FROM search_filtered_article_ids')
  expect(sql).toContain('search_filtered_article_ids.article_id = filter_posting_article.article_id')
})

test('buildReviewServingRowsSql intersects posting filters with all token-prefix search prefixes', () => {
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
    searchTokenPrefixesParameter: '$searchTokenPrefixes',
    snapshotIdParameter: '$snapshotId',
  })

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
  expect(sql).toContain('search_prefixes AS')
  expect(sql).toContain('SELECT DISTINCT token_prefix')
  expect(sql).toContain('search_candidate_article_ids AS')
  expect(sql).toContain('expanded_search_article_ids AS')
  expect(sql).toContain('search_filtered_article_ids AS')
  expect(sql.indexOf('search_candidate_article_ids AS')).toBeLessThan(sql.indexOf('expanded_search_article_ids AS'))
  expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM search_prefixes required_search_prefix')
  expect(sql).toContain('(NOT EXISTS (SELECT 1 FROM search_prefixes) OR EXISTS')
  expect(sql).toContain('EXISTS (SELECT 1 FROM search_filtered_article_ids')
  expect(sql).toContain('search_filtered_article_ids.article_id = filter_posting_article.article_id')
  expect(sql).not.toContain('starts_with(search.token, $searchTokenPrefix)')
  expect(sql).toContain(
    'FROM search_candidate_article_ids search_candidate_article JOIN mart.review_title_search_serving_v4 search ON list_contains(search.article_ids, search_candidate_article.article_id)',
  )
  expect(sql).not.toContain('CROSS JOIN UNNEST(search.article_ids) AS search_article(article_id)')
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

  expect(sql).toContain('list_mode_state.has_both_list_mode IS TRUE')
  expect(sql).toContain("'both' AS list_mode_key")
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
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

  expect(sql).toContain('unassessed_queue_page AS (SELECT')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain('list_mode_state.has_unassessed_list_mode IS TRUE')
  expect(sql).toContain('list_mode_state.unassessed_patch_watermark AS patch_watermark')
  expect(sql).toContain('queue.review_config_hash = $reviewConfigHash')
  expect(sql).toContain('queue.snapshot_id = $snapshotId')
  expect(sql).toContain("queue.queue_kind = 'unassessed'")
  expect(sql).toContain('serving.article_id = queue.article_id')
  expect(sql).toContain('unassessed_queue_candidate AS (SELECT')
  expect(sql).toContain('queue.activity_sort_at')
  expect(sql).not.toContain('MAX(queue.activity_sort_at) AS activity_sort_at')
  expect(sql).not.toContain('GROUP BY queue.project_id, queue.review_config_hash, queue.snapshot_id, queue.article_id')
  expect(sql).toContain(
    'ORDER BY unassessed_queue_candidate.activity_sort_at DESC, unassessed_queue_candidate.article_id DESC LIMIT $limit',
  )
  expect(sql).toContain('FROM unassessed_queue_page')
  expect(sql).toContain('unassessed_queue_page.activity_sort_at AS activity_sort_at')
  expect(sql).toContain('ORDER BY unassessed_queue_page.activity_sort_at DESC, unassessed_queue_page.article_id DESC')
  expect(sql).not.toContain('EXISTS (SELECT 1 FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
  expect(sql).not.toContain('JOIN mart.review_article_serving_v4')
  expect(sql).not.toContain('ORDER BY sort_key')
})

test('buildReviewServingRowsSql keeps unassessed article-set hydration bounded to provided queue article ids', () => {
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

  expect(sql).toContain('AND serving.article_id IN (SELECT unnest($articleIds))')
  expect(sql).not.toContain('EXISTS (SELECT 1 FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).not.toContain('queue.article_id = mart.review_article_serving_v4.article_id')
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
  expect(sql).not.toContain('JOIN mart.review_article_serving_v4')
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
  expect(assertReviewServingSqlShape(searchSql)).toEqual({ok: true, violations: []})
  expect(searchSql).toContain('WHERE app.review_search_job.project_id = $projectId')
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
  expect(sql).toContain('AND mart.review_article_judgment_detail_serving_v4.review_config_hash = $reviewConfigHash')
  expect(sql).toContain('AND mart.review_article_judgment_detail_serving_v4.snapshot_id = $snapshotId')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.list_mode_key')
  expect(sql).toContain("'both' AS list_mode_key")
  expect(sql).toContain("AND mart.review_article_judgment_detail_serving_v4.payload_kind = 'llm'")
  expect(sql).toContain('AND mart.review_article_judgment_detail_serving_v4.article_id IN (SELECT unnest($articleIds))')
  expect(sql).toContain('NULL AS judgment_model_id')
  expect(sql).toContain('NULL AS explanation')
  expect(sql).toContain('NULL AS quotes')
  expect(sql).not.toContain('llm_judgment.model_id AS judgment_model_id')
  expect(sql).not.toContain('llm_judgment.explanation AS explanation')
  expect(sql).not.toContain('llm_judgment.quotes AS quotes')
  expect(sql).not.toContain('LEFT JOIN app."judgment" llm_judgment')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.judgment_model_id')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.explanation')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.quotes')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.snapshot_project_model_name')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4.assessment_id')
  expect(sql).not.toContain('SELECT *')
  expect(sql).not.toContain('judgment_payload_json')
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
  expect(sql).toContain('list_mode_state.has_human_list_mode IS TRUE')
  expect(sql).toContain("'human' AS list_mode_key")
  expect(sql).toContain('AND serving.article_id IN (SELECT unnest($articleIds))')
  expect(sql).not.toContain('FROM mart.review_article_serving_v4')
})

test('buildReviewServingRowsSql sources article-row selected import route ids from selected-import snapshots', () => {
  const articleRowContractKeys = [
    'review.llm.rows',
    'review.llm.rowsByArticleSet',
    'review.human.rows',
    'review.human.rowsByArticleSet',
    'review.both.rows',
    'review.both.rowsByArticleSet',
    'review.unassessed.rows',
    'review.unassessed.rowsByArticleSet',
    'review.detail.row',
    'review.prompt.preview',
  ]

  for (const contractKey of articleRowContractKeys) {
    const contract = getRequiredReviewServingReadContract(contractKey)
    const sql = buildReviewServingRowsSql({
      articleIdParameter: contract.physicalAccessStrategy === 'keyedLookup' ? '$articleId' : null,
      articleIdsParameter: contract.physicalAccessStrategy === 'articleSetLookup' ? '$articleIds' : null,
      contract,
      displayIdentityParameter: '$displayIdentity',
      limitParameter: '$limit',
      listModeParameter: '$listMode',
      payloadIdentityParameter: '$payloadIdentity',
      projectIdParameter: '$projectId',
      projectScopeIdentityParameter: '$projectScopeIdentity',
      reviewConfigHashParameter: '$reviewConfigHash',
      searchIdentityParameter: '$searchIdentity',
      selectedImportSnapshotIdParameter: '$selectedImportSnapshotId',
      snapshotIdParameter: '$snapshotId',
    })

    expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
    expect(sql).toContain('selected_import.import_route_id AS selected_import_route_id')
    expect(sql).toContain('LEFT JOIN mart.review_selected_article_import_current_v4 selected_import')
    expect(sql).toContain('selected_import.project_id = $projectId')
    const articleSqlAlias = 'serving'

    expect(sql).toContain(`selected_import.project_id = ${articleSqlAlias}.project_id`)
    expect(sql).toContain('selected_import.project_scope_identity = $projectScopeIdentity')
    expect(sql).toContain('selected_import.selected_import_snapshot_id = $selectedImportSnapshotId')
    expect(sql).toContain(`selected_import.article_id = ${articleSqlAlias}.article_id`)
    expect(sql).toContain('AND NOT selected_import.tombstone')
    expect(sql).not.toContain('mart.review_article_serving_v4.selected_import_route_id')
  }
})

test('assertReviewServingSqlShape reads table references from SQL', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_base_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON list_contains(p.article_ids, s.article_id)
    WHERE s.project_id = ?
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `

  expect(getReviewServingSqlTableReferences(sql)).toEqual([
    'mart.review_article_serving_base_v4',
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

test('assertReviewServingSqlShape does not let canonical prompt fallback launder unrelated unsafe SQL', () => {
  const canonicalRowsSql = getReviewServingLazyPromptAnswerPostingRowsSql({
    filterValuesSql: "['review:promptAnswer:prompt-1:yes']",
    listModeSql: "'llm'",
    projectIdSql: "'project-1'",
    reviewConfigHashSql: "'config-1'",
    snapshotIdSql: "'snapshot-1'",
  })
  const sql = `
    WITH canonical_prompt_answer_posting_rows AS (
      ${canonicalRowsSql}
    ),
    posting_filter_rows AS (
      SELECT * FROM canonical_prompt_answer_posting_rows
    ),
    unrelated_unsafe AS (
      SELECT ROW_NUMBER() OVER () AS unsafe_rank
      FROM mart.review_article_serving_base_v4 unsafe_serving
      WHERE unsafe_serving.project_id = 'project-1'
        AND unsafe_serving.review_config_hash = 'config-1'
        AND unsafe_serving.snapshot_id = 'snapshot-1'
      GROUP BY unsafe_serving.article_id
    )
    SELECT serving.article_id
    FROM mart.review_article_serving_base_v4 serving
    WHERE serving.project_id = 'project-1'
      AND serving.review_config_hash = 'config-1'
      AND serving.snapshot_id = 'snapshot-1'
      AND EXISTS (
        SELECT 1
        FROM posting_filter_rows posting
        CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)
        WHERE posting.filter_kind = '${reviewServingPromptAnswerFilterKind}'
          AND posting_article.article_id = serving.article_id
      )
    ORDER BY serving.article_id
    LIMIT 1
  `
  const violations = getReviewServingSqlShapeViolations(sql, {allowCanonicalPromptAnswerFallback: true}).map(
    (violation) => {
      return violation.label
    },
  )

  expect(violations).toContain('window row number')
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
    FROM mart.review_article_serving_base_v4
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
    FROM mart.review_article_serving_base_v4
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
    FROM mart.review_article_serving_base_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON list_contains(p.article_ids, s.article_id)
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

test('assertReviewServingSqlShape allows scoped query-local posting article CTEs', () => {
  const sql = `
    WITH filter_4_articles AS (
      SELECT filter_4_article.article_id
      FROM mart.review_article_filter_posting_serving_v4 filter_4
      CROSS JOIN UNNEST(filter_4.article_ids) AS filter_4_article(article_id)
      WHERE filter_4.project_id = ?
        AND filter_4.snapshot_id = ?
        AND filter_4.review_config_hash = ?
        AND filter_4.list_mode_key = ?
        AND filter_4.filter_kind = ?
        AND filter_4.filter_value IN (SELECT unnest(?))
    )
    SELECT s.article_id
    FROM mart.review_article_serving_base_v4 s
    WHERE s.project_id = ?
      AND s.snapshot_id = ?
      AND EXISTS (
        SELECT 1
        FROM filter_4_articles
        WHERE filter_4_articles.article_id = s.article_id
      )
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `

  expect(assertReviewServingSqlShape(sql)).toEqual({ok: true, violations: []})
})

test('assertReviewServingSqlShape requires real bound scope predicates', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_base_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON list_contains(p.article_ids, s.article_id)
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
    FROM mart.review_article_serving_base_v4 s
    JOIN mart.review_article_filter_posting_serving_v4 p ON list_contains(p.article_ids, s.article_id)
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

test('assertReviewServingSqlShape requires driving-table scope predicates in the where clause', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_base_v4 s
    INNER JOIN mart.review_article_filter_posting_serving_v4 posting
      ON s.project_id = ?
      AND s.snapshot_id = ?
      AND posting.project_id = ?
      AND posting.snapshot_id = ?
      AND list_contains(posting.article_ids, s.article_id)
    WHERE posting.filter_kind = ?
    ORDER BY s.sort_key DESC, s.article_id DESC
    LIMIT ?
  `
  const violations = getReviewServingSqlShapeViolations(sql).map((violation) => {
    return violation.label
  })

  expect(violations).toContain('project scoped read: s')
  expect(violations).toContain('snapshot scoped read: s')
  expect(violations).not.toContain('project scoped read: posting')
  expect(violations).not.toContain('snapshot scoped read: posting')
})

test('assertReviewServingSqlShape rejects literal scope predicates', () => {
  const sql = `
    SELECT s.article_id
    FROM mart.review_article_serving_base_v4 s
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

test('reviewServing SQL guard exclusions are classified bounded or maintenance code', () => {
  const excludedReviewServingFiles = [...sqlGuardExcludedFiles].map((filePath) => {
    return relative(reviewServingSourceRoot, filePath)
  })
  const expectedExcludedFiles = [
    ...reviewServingMaintenanceAdmissionFiles,
    ...reviewServingBoundedForegroundAggregationFiles,
    'reviewServingResidualReadAllowlist.ts',
  ]

  expectedExcludedFiles.forEach((fileName) => {
    expect(excludedReviewServingFiles).toContain(fileName)
  })
})

test('mounted review residual reads are explicitly allowlisted', () => {
  const violations = reviewServingResidualReadAllowlist.flatMap((entry) => {
    const fileText = readFileSync(join(workspaceRoot, entry.routeFile), 'utf8')
    const missingMarkers = getReviewServingResidualReadMarkers(entry).filter((marker) => {
      return !fileText.includes(marker)
    })

    return missingMarkers.map((marker) => {
      return `${entry.routeFile}: missing residual read marker ${marker}`
    })
  })

  expect(violations).toEqual([])
})

test('judgment job foreground routes do not import legacy OLAP unassessed helpers', () => {
  const routeText = readFileSync(join(workspaceRoot, 'src/server/routes/JudgmentsJobsRoutes.ts'), 'utf8')
  const cronText = readFileSync(
    join(workspaceRoot, 'src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts'),
    'utf8',
  )

  expect(routeText).not.toContain('getUnassessedCountFromOlap')
  expect(routeText).not.toContain('getUnassessedArticlesFromOlap')
  expect(cronText).not.toContain('getUnassessedPairsFromOlap')
  expect(routeText).toContain('getJudgmentJobUnassessedCountFromServing')
  expect(cronText).toContain('getJudgmentJobUnassessedPairsFromServing')
})

test('judgment job serving queue SQL keeps current config and stable keyset semantics', () => {
  const serviceText = readFileSync(
    join(workspaceRoot, 'src/server/reviewServing/reviewServingJudgmentJobQueueService.ts'),
    'utf8',
  )

  expect(serviceText).toContain('getCurrentReviewServingReviewConfigHash')
  expect(serviceText).toContain('AND review_config_hash = ${getSqlLiteral(currentReviewConfigHash)}')
  expect(serviceText).toContain('INNER JOIN app.project_prompt current_prompt')
  expect(serviceText).toContain('AND current_prompt.enabled = TRUE')
  expect(serviceText).toContain('AND NOT current_prompt.archived')
  expect(serviceText).toContain("projectArticleAlias: 'project_article_scope'")
  expect(serviceText).toContain("articleRouteAlias: 'article_route_scope'")
  expect(serviceText).toContain("projectRouteAlias: 'current_project_route_scope'")
  expect(serviceText).toContain("projectArticleAlias: 'current_project_article_scope'")
  expect(serviceText).toContain('${articleAlias}.article_created_at >= current_project.date_from')
  expect(serviceText).toContain('${articleAlias}.article_created_at < current_project.date_to + INTERVAL 1 DAY')
  expect(serviceText).toContain("date_trunc('millisecond', queue.activity_sort_at)")
  expect(serviceText).toContain('queue.priority_bucket < ${priorityBucket}')
  expect(serviceText).toContain('AND ${promptIdExpression} < ${getSqlLiteral(cursor.lastPromptId)}')
  expect(serviceText).toContain('FROM queue_union source_queue')
  expect(serviceText).toContain('ORDER BY queue.priority_bucket DESC')
  expect(serviceText).toContain('queue.prompt_id DESC')
  expect(serviceText).not.toContain('AND article.selected_import_route_id IN')
  expect(serviceText).not.toContain('GROUP BY queue.article_id, queue.priority_bucket, queue.activity_sort_at')
})

test('retired OLAP imports stay away from normal review and judgment job foreground paths', () => {
  const candidateFiles = [
    ...reviewServingAdjacentRouteClassifications.map((entry) => {
      return entry.routeFile
    }),
    ...reviewServingResidualReadAllowlist.map((entry) => {
      return entry.routeFile
    }),
    'src/server/routes/JudgmentsJobsRoutes.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts',
  ]
  const violations = [...new Set(candidateFiles)].filter((routeFile) => {
    return readFileSync(join(workspaceRoot, routeFile), 'utf8').includes('duckdbOlap')
  })

  expect(violations).toEqual([])
})

test('mounted review and job foreground DuckDB calls use serving readers or explicit residual classifications', () => {
  const allowedRouteFiles = new Set<string>([
    ...reviewServingResidualReadAllowlist.map((entry) => {
      return entry.routeFile
    }),
    ...reviewServingAdjacentRouteClassifications
      .filter((entry) => {
        return entry.excludedFromNormalReviewFlow
      })
      .map((entry) => {
        return entry.routeFile
      }),
  ])
  const routeFiles = [
    ...reviewServingAdjacentRouteClassifications.map((entry) => {
      return entry.routeFile
    }),
    ...reviewServingResidualReadAllowlist.map((entry) => {
      return entry.routeFile
    }),
    'src/server/routes/JudgmentsJobsRoutes.ts',
  ]
  const violations = [...new Set(routeFiles)].filter((routeFile) => {
    const fileText = readFileSync(join(workspaceRoot, routeFile), 'utf8')
    const hasGenericDuckdbCall =
      /get(?:AppDatabaseService|ApiReadOnlyAppDatabaseService|JudgeWorkerReadOnlyAppDatabaseService)\(\)/u.test(
        fileText,
      )

    return hasGenericDuckdbCall && !allowedRouteFiles.has(routeFile) && !fileText.includes('readReviewServingRows')
  })

  expect(violations).toEqual([])
})

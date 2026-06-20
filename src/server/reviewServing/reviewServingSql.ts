import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingReadContract,
} from './reviewServingContracts.ts'
import {reviewServingReadContractList} from './reviewServingReadContracts.ts'
import {reviewServingSqlForbiddenPatterns} from './reviewServingSqlForbiddenPatterns.ts'

export type ReviewServingSqlShapeResult =
  | {ok: true; violations: []}
  | {ok: false; violations: readonly {label: string; pattern: string}[]}

export type ReviewServingSqlShapeOptions = {
  allowedTables?: readonly string[]
  requireLimit?: boolean
  requireOrderBy?: boolean
  requireProjectScope?: boolean
  requireRegisteredTable?: boolean
  requireSnapshotScope?: boolean
}

const tableReferencePattern = /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][\w]*)(?:\.(?:"[^"]+"|[a-z_][\w]*))?)/giu
const tableReferenceWithAliasPattern =
  /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][\w]*)(?:\.(?:"[^"]+"|[a-z_][\w]*))?)(?:\s+(?:as\s+)?((?!where\b|on\b|join\b|order\b|limit\b|group\b|having\b|qualify\b|using\b|inner\b|left\b|right\b|full\b|cross\b)(?:"[^"]+"|[a-z_][\w]*)))?/giu
const sqlClauseKeywords = new Set([
  'cross',
  'full',
  'group',
  'having',
  'inner',
  'join',
  'left',
  'limit',
  'on',
  'order',
  'qualify',
  'right',
  'using',
  'where',
])
type ReviewServingSqlTableReference = {alias: string | null; table: string}

export const reviewServingRegisteredSqlTables = [
  ...new Set(
    reviewServingReadContractList.map((contract) => {
      return contract.servingTable
    }),
  ),
].sort()

const getDefaultReviewServingSqlShapeOptions = (): Required<ReviewServingSqlShapeOptions> => {
  return {
    allowedTables: reviewServingRegisteredSqlTables,
    requireLimit: true,
    requireOrderBy: true,
    requireProjectScope: true,
    requireRegisteredTable: true,
    requireSnapshotScope: true,
  }
}

const getSortSql = (contract: ReviewServingReadContract) => {
  return contract.sort.fields
    .map((field) => {
      return /\b(?:asc|desc)\b/iu.test(field) ? field : `${field} ${contract.sort.direction.toUpperCase()}`
    })
    .join(', ')
}

const normalizeSqlIdentifier = (identifier: string) => {
  return identifier.replaceAll('"', '').toLowerCase()
}

const escapeRegex = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const getNormalizedSqlAlias = (alias: string | undefined) => {
  const normalizedAlias = alias ? normalizeSqlIdentifier(alias) : null

  return normalizedAlias && !sqlClauseKeywords.has(normalizedAlias) ? normalizedAlias : null
}

const getReviewServingSqlForbiddenPatternViolations = (sql: string) => {
  return reviewServingSqlForbiddenPatterns
    .filter((forbiddenPattern) => {
      return forbiddenPattern.pattern.test(sql)
    })
    .map((forbiddenPattern) => {
      return {label: forbiddenPattern.label, pattern: String(forbiddenPattern.pattern)}
    })
}

export const getReviewServingSqlTableReferences = (sql: string) => {
  return [
    ...new Set(
      [...sql.matchAll(tableReferencePattern)].map((match) => {
        return normalizeSqlIdentifier(match[1] ?? '')
      }),
    ),
  ].filter((tableReference) => {
    return tableReference.length > 0
  })
}

const getReviewServingSqlTableReferenceDetails = (sql: string): ReviewServingSqlTableReference[] => {
  return [...sql.matchAll(tableReferenceWithAliasPattern)]
    .map((match) => {
      return {alias: getNormalizedSqlAlias(match[2]), table: normalizeSqlIdentifier(match[1] ?? '')}
    })
    .filter((tableReference) => {
      return tableReference.table.length > 0
    })
}

const getReviewServingSqlRegisteredTableViolations = (sql: string, options: Required<ReviewServingSqlShapeOptions>) => {
  if (!options.requireRegisteredTable) {
    return []
  }

  const allowedTables = new Set(
    options.allowedTables.map((table) => {
      return normalizeSqlIdentifier(table)
    }),
  )
  const tableReferences = getReviewServingSqlTableReferences(sql)
  const missingTableViolations =
    tableReferences.length === 0
      ? [{label: 'registered serving table', pattern: 'FROM <registered review-serving table>'}]
      : []
  const unregisteredTableViolations = tableReferences
    .filter((tableReference) => {
      return !allowedTables.has(tableReference)
    })
    .map((tableReference) => {
      return {label: `unregistered table reference: ${tableReference}`, pattern: tableReference}
    })

  return [...missingTableViolations, ...unregisteredTableViolations]
}

const getReviewServingSqlBoundedReadViolations = (sql: string, options: Required<ReviewServingSqlShapeOptions>) => {
  const tableReferences = getReviewServingSqlTableReferenceDetails(sql)
  const hasMultipleReferences = tableReferences.length > 1
  const scopedPredicateClause =
    sql.match(/\bfrom\b([\s\S]*?)(?:\bqualify\b|\border\s+by\b|\blimit\b|\bgroup\s+by\b|\bhaving\b|$)/iu)?.[1] ?? ''
  const bindOperandPattern = '(?:\\?|[$:@](?:[a-z_][\\w.]*|[0-9]+))'
  const getQualifierPattern = (tableReference: ReviewServingSqlTableReference) => {
    if (tableReference.alias) {
      return `${escapeRegex(tableReference.alias)}\\s*\\.\\s*`
    }

    return hasMultipleReferences ? `${escapeRegex(tableReference.table)}\\s*\\.\\s*` : '(?:[a-z_][\\w]*\\s*\\.\\s*)?'
  }
  const getScopePredicatePattern = (
    tableReference: ReviewServingSqlTableReference,
    field: 'project_id' | 'snapshot_id',
  ) => {
    const qualifiedFieldPattern = `${getQualifierPattern(tableReference)}${field}`

    return new RegExp(
      `(?:\\b${qualifiedFieldPattern}\\b\\s*(?:=|is\\s+not\\s+distinct\\s+from)\\s*${bindOperandPattern}|${bindOperandPattern}\\s*(?:=|is\\s+not\\s+distinct\\s+from)\\s*\\b${qualifiedFieldPattern}\\b)`,
      'iu',
    )
  }
  const getScopeViolations = (field: 'project_id' | 'snapshot_id', label: string, required: boolean) => {
    return required
      ? tableReferences
          .filter((tableReference) => {
            return !getScopePredicatePattern(tableReference, field).test(scopedPredicateClause)
          })
          .map((tableReference) => {
            const scopedLabel = tableReference.alias ?? tableReference.table

            return tableReferences.length === 1
              ? {label, pattern: `WHERE ... ${field}`}
              : {label: `${label}: ${scopedLabel}`, pattern: `${scopedLabel}.${field}`}
          })
      : []
  }
  const projectScopeViolations = getScopeViolations('project_id', 'project scoped read', options.requireProjectScope)
  const snapshotScopeViolations = getScopeViolations(
    'snapshot_id',
    'snapshot scoped read',
    options.requireSnapshotScope,
  )
  const orderByViolations =
    options.requireOrderBy && !/\border\s+by\b/iu.test(sql) ? [{label: 'keyset ordering', pattern: 'ORDER BY'}] : []
  const limitViolations =
    options.requireLimit && !/\blimit\b/iu.test(sql) ? [{label: 'bounded limit', pattern: 'LIMIT'}] : []

  return [...projectScopeViolations, ...snapshotScopeViolations, ...orderByViolations, ...limitViolations]
}

export const getReviewServingSqlShapeViolations = (sql: string, options?: ReviewServingSqlShapeOptions) => {
  const shapeOptions = {...getDefaultReviewServingSqlShapeOptions(), ...options}

  return [
    ...getReviewServingSqlForbiddenPatternViolations(sql),
    ...getReviewServingSqlRegisteredTableViolations(sql, shapeOptions),
    ...getReviewServingSqlBoundedReadViolations(sql, shapeOptions),
  ]
}

export const assertReviewServingSqlShape = (
  sql: string,
  options?: ReviewServingSqlShapeOptions,
): ReviewServingSqlShapeResult => {
  const violations = getReviewServingSqlShapeViolations(sql, options)
  return violations.length === 0 ? {ok: true, violations: []} : {ok: false, violations}
}

const reviewServingSnapshotManifestTable = 'app.review_serving_snapshot_manifest'
const reviewServingBulkOperationJobTable = 'app.review_bulk_operation_job'
const reviewServingSearchJobTable = 'app.review_search_job'
const reviewServingArticleTable = 'mart.review_article_serving_v4'
const reviewServingPayloadTable = 'mart.review_article_serving_payload_v4'
const reviewServingFilterFacetTable = 'mart.review_filter_facet_serving_v4'
const reviewServingFilterOptionTable = 'mart.review_filter_option_serving_v4'
const reviewServingJudgmentDetailTable = 'mart.review_article_judgment_detail_serving_v4'
const reviewServingListModePrioritySql =
  "CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END"
const reviewServingListModePriorityAlias = 'list_mode_priority'

const getReviewServingRowsSqlIdentityPredicates = (params: {
  contract: ReviewServingReadContract
  displayIdentityParameter: string
  filterOptionIdentityParameter?: string | null
  payloadIdentityParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  snapshotIdParameter: string
}) => {
  if (params.contract.servingTable === reviewServingPayloadTable) {
    return ` AND display_identity = ${params.displayIdentityParameter} AND payload_identity = ${params.payloadIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
  }

  if (params.contract.servingTable === reviewServingSnapshotManifestTable) {
    return ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter} AND snapshot_status IN ('active', 'retired')`
  }

  if (params.contract.servingTable === reviewServingSearchJobTable) {
    return ''
  }

  if (params.contract.servingTable === reviewServingBulkOperationJobTable) {
    return ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter} AND (snapshot_id = ${params.snapshotIdParameter} OR (latest_snapshot_semantics = TRUE AND snapshot_id IS NULL))`
  }

  if (params.contract.servingTable === reviewServingFilterOptionTable) {
    const filterOptionIdentityParameter = getRequiredReviewServingRowsSqlParameter(
      params.filterOptionIdentityParameter,
      'filter option identity',
      params.contract,
    )

    return ` AND review_config_hash = ${params.reviewConfigHashParameter} AND snapshot_id = ${params.snapshotIdParameter} AND search_identity = ${params.searchIdentityParameter} AND filter_option_identity = ${filterOptionIdentityParameter}`
  }

  const snapshotIdColumn = getReviewServingRowsSqlScopeColumn({contract: params.contract, field: 'snapshot_id'})

  return params.contract.servingTable === 'mart.review_title_search_serving_v4'
    ? ` AND search_identity = ${params.searchIdentityParameter} AND project_scope_identity = ${params.projectScopeIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
    : ` AND review_config_hash = ${params.reviewConfigHashParameter} AND ${snapshotIdColumn} = ${params.snapshotIdParameter}`
}

const reviewServingListModePredicateTables = new Set([
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_article_serving_v4',
])
const reviewServingCountServingTable = 'mart.review_article_count_serving_v4'
const reviewServingRuntimeListModeStrategies = new Set(['postingIntersection'])
const reviewServingCountListModesByKey: Partial<Record<NamedReviewFastCountKey, string>> = {
  'review.both.conflictByPrompt': 'both',
  'review.human.reviewedByPrompt': 'human',
  'review.llm.assessedByPrompt': 'llm',
  'review.llm.unassessedByPrompt': 'unassessed',
  'review.queue.unassessedReady': 'unassessed',
}

const getReviewServingRowsSqlListModePredicate = (params: {
  contract: ReviewServingReadContract
  listModeParameter: string
}) => {
  if (!reviewServingListModePredicateTables.has(params.contract.servingTable)) {
    return ''
  }

  if (params.contract.listMode) {
    return ` AND list_mode_key = ${getSqlStringLiteral(params.contract.listMode)}`
  }

  return reviewServingRuntimeListModeStrategies.has(params.contract.physicalAccessStrategy)
    ? ` AND list_mode_key = ${params.listModeParameter}`
    : ''
}

const getReviewServingRowsSqlJudgmentPayloadKindPredicate = (contract: ReviewServingReadContract) => {
  if (contract.servingTable !== reviewServingJudgmentDetailTable) {
    return ''
  }

  return contract.key === 'review.detail.humanJudgments'
    || contract.key === 'review.human.list.judgments'
    || contract.key === 'review.both.list.humanJudgments'
    ? " AND payload_kind = 'human'"
    : " AND payload_kind = 'llm'"
}

const getSqlStringLiteral = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getReviewServingRowsSqlCountPredicate = (params: {
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
  listModeParameter: string
  namedCountKey?: NamedReviewFastCountKey | null
}) => {
  if (params.contract.servingTable !== reviewServingCountServingTable) {
    return ''
  }

  if (!params.namedCountKey || !params.contract.namedFastCounts.includes(params.namedCountKey)) {
    throw new Error(`Missing supported named count key for ${params.contract.key}`)
  }

  if (!params.countFilterKeyParameter) {
    throw new Error(`Missing count filter key for ${params.contract.key}`)
  }

  const summaryDefinition = namedReviewFastCountDefinitions[params.namedCountKey]
  const listModeKey = reviewServingCountListModesByKey[params.namedCountKey] ?? params.contract.listMode ?? 'global'
  const listModePredicate = ` AND list_mode_key = ${getSqlStringLiteral(listModeKey)}`

  return [
    listModePredicate,
    ` AND count_kind = ${getSqlStringLiteral(params.namedCountKey)}`,
    ` AND summary_definition_version = ${getSqlStringLiteral(summaryDefinition.summaryDefinitionVersion)}`,
    ` AND filter_key = ${params.countFilterKeyParameter}`,
  ].join('')
}

const getReviewServingRowsSqlFacetVersionPredicate = (params: {
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
}) => {
  if (params.contract.servingTable !== reviewServingFilterFacetTable) {
    return ''
  }

  const facetDefinitionVersions = params.contract.namedFastCounts
    .map((countKey) => {
      return namedReviewFastCountDefinitions[countKey]
    })
    .filter((definition) => {
      return definition.kind === 'facet'
    })
    .map((definition) => {
      return getSqlStringLiteral(definition.summaryDefinitionVersion)
    })

  if (facetDefinitionVersions.length === 0) {
    throw new Error(`Missing facet summary definition for ${params.contract.key}`)
  }

  const countFilterKeyParameter = getRequiredReviewServingRowsSqlParameter(
    params.countFilterKeyParameter,
    'facet filter key',
    params.contract,
  )

  const facetKindPredicate =
    params.contract.key === 'review.human.filters.facets' ? " AND facet_kind = 'human'" : " AND facet_kind = 'review'"
  const summaryVersionPredicate =
    facetDefinitionVersions.length === 1
      ? ` AND summary_definition_version = ${facetDefinitionVersions[0]}`
      : ` AND summary_definition_version IN (${facetDefinitionVersions.join(', ')})`

  return `${facetKindPredicate}${summaryVersionPredicate} AND summary_identity = ${countFilterKeyParameter}`
}

const getRequiredReviewServingRowsSqlParameter = (
  parameter: string | null | undefined,
  label: string,
  contract: ReviewServingReadContract,
) => {
  if (!parameter) {
    throw new Error(`Missing ${label} for ${contract.key}`)
  }

  return parameter
}

const getReviewServingRowsSqlScopeColumn = (params: {contract: ReviewServingReadContract; field: string}) => {
  return `${params.contract.servingTable}.${params.field}`
}

const getReviewServingRowsSqlArticlePredicate = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
}) => {
  if (!params.contract.allowedFilters.includes('articleId')) {
    return ''
  }

  if (params.contract.physicalAccessStrategy === 'articleSetLookup') {
    const articleIdsParameter = getRequiredReviewServingRowsSqlParameter(
      params.articleIdsParameter,
      'article ids',
      params.contract,
    )

    return ` AND article_id IN (SELECT unnest(${articleIdsParameter}))`
  }

  if (params.contract.physicalAccessStrategy !== 'keyedLookup') {
    return ''
  }

  const articleIdParameter = getRequiredReviewServingRowsSqlParameter(
    params.articleIdParameter,
    'article id',
    params.contract,
  )

  return ` AND article_id = ${articleIdParameter}`
}

const getReviewServingRowsSqlPostingPredicate = (params: {
  contract: ReviewServingReadContract
  filterPredicatesSql?: string | null
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  listModeParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTokenPrefixParameter?: string | null
  snapshotIdParameter: string
}) => {
  if (params.contract.physicalAccessStrategy !== 'postingIntersection') {
    return ''
  }

  const filterKindParameter = getRequiredReviewServingRowsSqlParameter(
    params.filterKindParameter,
    'filter kind',
    params.contract,
  )
  const filterValueParameter = getRequiredReviewServingRowsSqlParameter(
    params.filterValueParameter,
    'filter value',
    params.contract,
  )

  const anchorPredicate = ` AND filter_kind = ${filterKindParameter} AND filter_value = ${filterValueParameter}`
  const searchPredicate = params.searchTokenPrefixParameter
    ? [
        ' AND EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search',
        ` WHERE search.project_id = ${params.projectIdParameter}`,
        ` AND search.search_identity = ${params.searchIdentityParameter}`,
        ` AND search.project_scope_identity = ${params.projectScopeIdentityParameter}`,
        ` AND search.snapshot_id = ${params.snapshotIdParameter}`,
        ` AND search.article_id = ${params.contract.servingTable}.article_id`,
        ` AND starts_with(search.token, ${params.searchTokenPrefixParameter}))`,
      ].join('')
    : ''

  if (!params.filterPredicatesSql) {
    return `${anchorPredicate}${searchPredicate}`
  }

  throw new Error(`Multi-filter posting intersections require a precomputed serving lookup for ${params.contract.key}`)
}

const getReviewServingRowsSqlSearchPredicate = (params: {
  contract: ReviewServingReadContract
  searchTokenPrefixParameter?: string | null
}) => {
  if (params.contract.physicalAccessStrategy !== 'tokenPrefixIndex') {
    return ''
  }

  const searchTokenPrefixParameter = getRequiredReviewServingRowsSqlParameter(
    params.searchTokenPrefixParameter,
    'search token prefix',
    params.contract,
  )

  return ` AND starts_with(token, ${searchTokenPrefixParameter})`
}

const getReviewServingRowsSqlQueuePredicate = (params: {
  contract: ReviewServingReadContract
  projectIdParameter: string
  projectScopeIdentityParameter: string
  queueKindParameter?: string | null
  searchIdentityParameter: string
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  snapshotIdParameter: string
}) => {
  if (params.contract.physicalAccessStrategy !== 'queueOrdering') {
    return ''
  }

  const queueKindParameter = getRequiredReviewServingRowsSqlParameter(
    params.queueKindParameter,
    'queue kind',
    params.contract,
  )

  const searchPredicate = params.searchTokenPrefixesParameter
    ? [
        ` AND NOT EXISTS (SELECT 1 FROM (SELECT unnest(${params.searchTokenPrefixesParameter}) AS token_prefix) search_prefix`,
        ' WHERE NOT EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search',
        ` WHERE search.project_id = ${params.projectIdParameter}`,
        ` AND search.search_identity = ${params.searchIdentityParameter}`,
        ` AND search.project_scope_identity = ${params.projectScopeIdentityParameter}`,
        ` AND search.snapshot_id = ${params.snapshotIdParameter}`,
        ` AND search.article_id = ${params.contract.servingTable}.article_id`,
        ' AND starts_with(search.token, search_prefix.token_prefix)))',
      ].join('')
    : ''

  return ` AND queue_kind = ${queueKindParameter}${searchPredicate}`
}

const getReviewServingRowsSqlUnassessedQueuePredicate = (params: {
  contract: ReviewServingReadContract
  projectIdParameter: string
  reviewConfigHashParameter: string
  snapshotIdParameter: string
}) => {
  return params.contract.key === 'review.unassessed.rows'
    ? [
        ' AND EXISTS (SELECT 1 FROM mart.review_unassessed_queue_serving_v4 queue',
        ` WHERE queue.project_id = ${params.projectIdParameter}`,
        ` AND queue.review_config_hash = ${params.reviewConfigHashParameter}`,
        ` AND queue.snapshot_id = ${params.snapshotIdParameter}`,
        " AND queue.queue_kind = 'unassessed'",
        ` AND queue.article_id = ${params.contract.servingTable}.article_id)`,
      ].join('')
    : ''
}

const getReviewServingRowsSqlJobPredicate = (params: {
  contract: ReviewServingReadContract
  jobFilterSignatureParameter?: string | null
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTextParameter?: string | null
  snapshotIdParameter: string
}) => {
  if (params.contract.physicalAccessStrategy !== 'jobCriteria') {
    return ''
  }

  const jobFilterSignatureParameter = getRequiredReviewServingRowsSqlParameter(
    params.jobFilterSignatureParameter,
    'job filter signature',
    params.contract,
  )

  if (params.contract.servingTable === reviewServingBulkOperationJobTable) {
    return ` AND job_kind = ${getSqlStringLiteral(params.contract.key)} AND filter_signature = ${jobFilterSignatureParameter}`
  }

  if (params.contract.servingTable === reviewServingSearchJobTable) {
    const searchTextParameter = getRequiredReviewServingRowsSqlParameter(
      params.searchTextParameter,
      'search text',
      params.contract,
    )

    return [
      ` AND search_identity IS NOT DISTINCT FROM ${params.searchIdentityParameter}`,
      ` AND project_scope_identity = ${params.projectScopeIdentityParameter}`,
      ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter}`,
      ` AND snapshot_id IS NOT DISTINCT FROM ${params.snapshotIdParameter}`,
      ` AND search_mode = ${getSqlStringLiteral(params.contract.searchMode)}`,
      ` AND search_text = ${searchTextParameter}`,
      ` AND filter_signature = ${jobFilterSignatureParameter}`,
    ].join('')
  }

  throw new Error(`Unsupported job criteria table for ${params.contract.key}`)
}

const getReviewServingRowsSqlListModeDedupeQualifier = (contract: ReviewServingReadContract) => {
  return contract.servingTable === reviewServingJudgmentDetailTable
    ? ` QUALIFY ${reviewServingListModePrioritySql} = min(${reviewServingListModePrioritySql}) OVER (PARTITION BY article_id, prompt_id)`
    : ''
}

const getReviewServingRowsSqlSelect = (contract: ReviewServingReadContract) => {
  if (contract.servingTable === reviewServingArticleTable) {
    return contract.sort.fields.some((field) => {
      return field.includes(reviewServingListModePrioritySql)
    })
      ? `SELECT ${reviewServingArticleTable}.*, payload.source_metadata, ${reviewServingListModePrioritySql} AS ${reviewServingListModePriorityAlias}`
      : `SELECT ${reviewServingArticleTable}.*, payload.source_metadata`
  }

  return contract.sort.fields.some((field) => {
    return field.includes(reviewServingListModePrioritySql)
  })
    ? `SELECT *, ${reviewServingListModePrioritySql} AS ${reviewServingListModePriorityAlias}`
    : 'SELECT *'
}

const getReviewServingRowsSqlPhysicalFilterPredicate = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
  filterPredicatesSql?: string | null
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  jobFilterSignatureParameter?: string | null
  listModeParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  queueKindParameter?: string | null
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  searchTextParameter?: string | null
  snapshotIdParameter: string
}) => {
  return [
    getReviewServingRowsSqlArticlePredicate(params),
    getReviewServingRowsSqlPostingPredicate(params),
    getReviewServingRowsSqlSearchPredicate(params),
    getReviewServingRowsSqlQueuePredicate(params),
    getReviewServingRowsSqlUnassessedQueuePredicate(params),
    getReviewServingRowsSqlJobPredicate(params),
    params.filterPredicatesSql ?? '',
  ].join('')
}

export const buildReviewServingRowsSql = (params: {
  articleIdParameter?: string | null
  articleIdsParameter?: string | null
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
  cursorPredicate?: string
  displayIdentityParameter: string
  filterOptionIdentityParameter?: string | null
  filterPredicatesSql?: string | null
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  jobFilterSignatureParameter?: string | null
  limitParameter: string
  listModeParameter: string
  namedCountKey?: NamedReviewFastCountKey | null
  payloadIdentityParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  queueKindParameter?: string | null
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTextParameter?: string | null
  searchTokenPrefixParameter?: string | null
  searchTokenPrefixesParameter?: string | null
  snapshotIdParameter: string
}) => {
  const articlePayloadJoin =
    params.contract.servingTable === reviewServingArticleTable
      ? [
          ` LEFT JOIN ${reviewServingPayloadTable} payload`,
          ` ON payload.project_id = ${params.projectIdParameter}`,
          ` AND payload.project_id = ${reviewServingArticleTable}.project_id`,
          ` AND payload.display_identity = ${reviewServingArticleTable}.display_identity`,
          ` AND payload.payload_identity = ${reviewServingArticleTable}.payload_identity`,
          ` AND payload.snapshot_id = ${params.snapshotIdParameter}`,
          ` AND payload.snapshot_id = ${reviewServingArticleTable}.snapshot_id`,
          ` AND payload.article_id = ${reviewServingArticleTable}.article_id`,
        ].join('')
      : ''
  const cursorPredicate = params.cursorPredicate ? ` AND (${params.cursorPredicate})` : ''
  const identityPredicates = getReviewServingRowsSqlIdentityPredicates(params)
  const listModePredicate = getReviewServingRowsSqlListModePredicate(params)
  const judgmentPayloadKindPredicate = getReviewServingRowsSqlJudgmentPayloadKindPredicate(params.contract)
  const countPredicate = getReviewServingRowsSqlCountPredicate(params)
  const facetVersionPredicate = getReviewServingRowsSqlFacetVersionPredicate(params)
  const physicalFilterPredicate = getReviewServingRowsSqlPhysicalFilterPredicate(params)
  const listModeDedupeQualifier = getReviewServingRowsSqlListModeDedupeQualifier(params.contract)
  const selectSql = getReviewServingRowsSqlSelect(params.contract)
  const sortSql = getSortSql(params.contract)

  const projectIdColumn = getReviewServingRowsSqlScopeColumn({contract: params.contract, field: 'project_id'})

  return [
    `${selectSql} FROM ${params.contract.servingTable}${articlePayloadJoin} WHERE ${projectIdColumn} = ${params.projectIdParameter}`,
    identityPredicates,
    listModePredicate,
    judgmentPayloadKindPredicate,
    countPredicate,
    facetVersionPredicate,
    physicalFilterPredicate,
    cursorPredicate,
    listModeDedupeQualifier,
    ` ORDER BY ${sortSql} LIMIT ${params.limitParameter}`,
  ].join('')
}

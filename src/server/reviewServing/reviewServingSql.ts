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
  /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][\w]*)(?:\.(?:"[^"]+"|[a-z_][\w]*))?)(?:\s+(?:as\s+)?((?!where\b|on\b|join\b|order\b|limit\b|group\b|having\b|using\b|inner\b|left\b|right\b|full\b|cross\b)(?:"[^"]+"|[a-z_][\w]*)))?/giu
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
  const wherePredicateClause =
    sql.match(/\bwhere\b([\s\S]*?)(?:\border\s+by\b|\blimit\b|\bgroup\s+by\b|\bhaving\b|$)/iu)?.[1] ?? ''
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
            return !getScopePredicatePattern(tableReference, field).test(wherePredicateClause)
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

const getReviewServingRowsSqlIdentityPredicates = (params: {
  contract: ReviewServingReadContract
  displayIdentityParameter: string
  payloadIdentityParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  snapshotIdParameter: string
}) => {
  if (params.contract.servingTable === 'mart.review_article_serving_payload_v4') {
    return ` AND display_identity = ${params.displayIdentityParameter} AND payload_identity = ${params.payloadIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
  }

  if (params.contract.servingTable === 'app.review_serving_snapshot_manifest') {
    return ` AND review_config_hash IS NOT DISTINCT FROM ${params.reviewConfigHashParameter} AND snapshot_id = ${params.snapshotIdParameter}`
  }

  return params.contract.servingTable === 'mart.review_title_search_serving_v4'
    ? ` AND search_identity = ${params.searchIdentityParameter} AND project_scope_identity = ${params.projectScopeIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
    : ` AND review_config_hash = ${params.reviewConfigHashParameter} AND snapshot_id = ${params.snapshotIdParameter}`
}

const reviewServingListModePredicateTables = new Set([
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_serving_v4',
])
const reviewServingCountServingTable = 'mart.review_article_count_serving_v4'
const reviewServingRuntimeListModeStrategies = new Set(['postingIntersection'])

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
  const listModePredicate = params.contract.listMode
    ? ` AND list_mode_key = ${params.listModeParameter}`
    : ` AND list_mode_key = 'global'`

  return [
    listModePredicate,
    ` AND count_kind = ${getSqlStringLiteral(params.namedCountKey)}`,
    ` AND summary_definition_version = ${getSqlStringLiteral(summaryDefinition.summaryDefinitionVersion)}`,
    ` AND filter_key = ${params.countFilterKeyParameter}`,
  ].join('')
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

const getReviewServingRowsSqlArticlePredicate = (params: {
  articleIdParameter?: string | null
  contract: ReviewServingReadContract
}) => {
  if (
    params.contract.physicalAccessStrategy !== 'keyedLookup'
    || !params.contract.allowedFilters.includes('articleId')
  ) {
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
  filterKindParameter?: string | null
  filterValueParameter?: string | null
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

  return ` AND filter_kind = ${filterKindParameter} AND filter_value = ${filterValueParameter}`
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
  queueKindParameter?: string | null
}) => {
  if (params.contract.physicalAccessStrategy !== 'queueOrdering') {
    return ''
  }

  const queueKindParameter = getRequiredReviewServingRowsSqlParameter(
    params.queueKindParameter,
    'queue kind',
    params.contract,
  )

  return ` AND queue_kind = ${queueKindParameter}`
}

const getReviewServingRowsSqlPhysicalFilterPredicate = (params: {
  articleIdParameter?: string | null
  contract: ReviewServingReadContract
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  queueKindParameter?: string | null
  searchTokenPrefixParameter?: string | null
}) => {
  return [
    getReviewServingRowsSqlArticlePredicate(params),
    getReviewServingRowsSqlPostingPredicate(params),
    getReviewServingRowsSqlSearchPredicate(params),
    getReviewServingRowsSqlQueuePredicate(params),
  ].join('')
}

export const buildReviewServingRowsSql = (params: {
  articleIdParameter?: string | null
  contract: ReviewServingReadContract
  countFilterKeyParameter?: string | null
  cursorPredicate?: string
  displayIdentityParameter: string
  filterKindParameter?: string | null
  filterValueParameter?: string | null
  limitParameter: string
  listModeParameter: string
  namedCountKey?: NamedReviewFastCountKey | null
  payloadIdentityParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  queueKindParameter?: string | null
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  searchTokenPrefixParameter?: string | null
  snapshotIdParameter: string
}) => {
  const cursorPredicate = params.cursorPredicate ? ` AND (${params.cursorPredicate})` : ''
  const identityPredicates = getReviewServingRowsSqlIdentityPredicates(params)
  const listModePredicate = getReviewServingRowsSqlListModePredicate(params)
  const countPredicate = getReviewServingRowsSqlCountPredicate(params)
  const physicalFilterPredicate = getReviewServingRowsSqlPhysicalFilterPredicate(params)
  const sortSql = getSortSql(params.contract)

  return [
    `SELECT * FROM ${params.contract.servingTable} WHERE project_id = ${params.projectIdParameter}`,
    identityPredicates,
    listModePredicate,
    countPredicate,
    physicalFilterPredicate,
    cursorPredicate,
    ` ORDER BY ${sortSql} LIMIT ${params.limitParameter}`,
  ].join('')
}

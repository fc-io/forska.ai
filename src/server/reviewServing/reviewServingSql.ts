import type {ReviewServingReadContract} from './reviewServingContracts.ts'
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
      return `${field} ${contract.sort.direction.toUpperCase()}`
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
  const getQualifierPattern = (tableReference: ReviewServingSqlTableReference) => {
    if (tableReference.alias) {
      return `${escapeRegex(tableReference.alias)}\\s*\\.\\s*`
    }

    return hasMultipleReferences ? `${escapeRegex(tableReference.table)}\\s*\\.\\s*` : '(?:[a-z_][\\w]*\\s*\\.\\s*)?'
  }
  const getScopeViolations = (field: 'project_id' | 'snapshot_id', label: string, required: boolean) => {
    return required
      ? tableReferences
          .filter((tableReference) => {
            return !new RegExp(`\\bwhere\\b[\\s\\S]*\\b${getQualifierPattern(tableReference)}${field}\\b`, 'iu').test(
              sql,
            )
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

  return params.contract.servingTable === 'mart.review_title_search_serving_v4'
    ? ` AND search_identity = ${params.searchIdentityParameter} AND project_scope_identity = ${params.projectScopeIdentityParameter} AND snapshot_id = ${params.snapshotIdParameter}`
    : ` AND review_config_hash = ${params.reviewConfigHashParameter} AND snapshot_id = ${params.snapshotIdParameter}`
}

const reviewServingListModePredicateTables = new Set([
  'mart.review_article_filter_posting_serving_v4',
  'mart.review_article_serving_v4',
])

const getReviewServingRowsSqlListModePredicate = (params: {
  contract: ReviewServingReadContract
  listModeParameter: string
}) => {
  return params.contract.listMode && reviewServingListModePredicateTables.has(params.contract.servingTable)
    ? ` AND list_mode_key = ${params.listModeParameter}`
    : ''
}

export const buildReviewServingRowsSql = (params: {
  contract: ReviewServingReadContract
  cursorPredicate?: string
  displayIdentityParameter: string
  limitParameter: string
  listModeParameter: string
  payloadIdentityParameter: string
  projectIdParameter: string
  projectScopeIdentityParameter: string
  reviewConfigHashParameter: string
  searchIdentityParameter: string
  snapshotIdParameter: string
}) => {
  const cursorPredicate = params.cursorPredicate ? ` AND (${params.cursorPredicate})` : ''
  const identityPredicates = getReviewServingRowsSqlIdentityPredicates(params)
  const listModePredicate = getReviewServingRowsSqlListModePredicate(params)
  const sortSql = getSortSql(params.contract)

  return `SELECT * FROM ${params.contract.servingTable} WHERE project_id = ${params.projectIdParameter}${identityPredicates}${listModePredicate}${cursorPredicate} ORDER BY ${sortSql} LIMIT ${params.limitParameter}`
}

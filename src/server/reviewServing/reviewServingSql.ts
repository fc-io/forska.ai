import type {ReviewServingReadContract} from './reviewServingContracts.ts'

export type ReviewServingSqlForbiddenPattern = {label: string; pattern: RegExp}

export type ReviewServingSqlShapeResult =
  | {ok: true; violations: []}
  | {ok: false; violations: readonly {label: string; pattern: string}[]}

export const reviewServingSqlForbiddenPatterns: readonly ReviewServingSqlForbiddenPattern[] = [
  {label: 'selected scoped import CTE', pattern: /\bselected_scoped_article_import\b/iu},
  {label: 'window row number', pattern: /\brow_number\s*\(/iu},
  {label: 'offset pagination', pattern: /\boffset\b/iu},
  {label: 'raw article table scan', pattern: /\b(from|join)\s+app\.article\b/iu},
  {label: 'raw judgment table scan', pattern: /\b(from|join)\s+app\.judgment\b/iu},
  {label: 'raw human judgment table scan', pattern: /\b(from|join)\s+app\.judgment_human\b/iu},
  {label: 'json extraction', pattern: /\bjson_extract(?:_string)?\s*\(/iu},
  {label: 'foreground aggregation', pattern: /\bgroup\s+by\b/iu},
]

const getSortSql = (contract: ReviewServingReadContract) => {
  return contract.sort.fields
    .map((field) => {
      return `${field} ${contract.sort.direction.toUpperCase()}`
    })
    .join(', ')
}

export const getReviewServingSqlShapeViolations = (sql: string) => {
  return reviewServingSqlForbiddenPatterns
    .filter((forbiddenPattern) => {
      return forbiddenPattern.pattern.test(sql)
    })
    .map((forbiddenPattern) => {
      return {label: forbiddenPattern.label, pattern: String(forbiddenPattern.pattern)}
    })
}

export const assertReviewServingSqlShape = (sql: string): ReviewServingSqlShapeResult => {
  const violations = getReviewServingSqlShapeViolations(sql)
  return violations.length === 0 ? {ok: true, violations: []} : {ok: false, violations}
}

export const buildReviewServingRowsSql = (params: {
  contract: ReviewServingReadContract
  cursorPredicate?: string
  limitParameter: string
  projectIdParameter: string
}) => {
  const cursorPredicate = params.cursorPredicate ? ` AND (${params.cursorPredicate})` : ''
  const sortSql = getSortSql(params.contract)

  return `SELECT * FROM ${params.contract.servingTable} WHERE project_id = ${params.projectIdParameter}${cursorPredicate} ORDER BY ${sortSql} LIMIT ${params.limitParameter}`
}

export type ReviewServingSqlForbiddenPattern = {label: string; pattern: RegExp}

export const reviewServingSqlForbiddenPatterns: readonly ReviewServingSqlForbiddenPattern[] = [
  {label: 'selected scoped import CTE', pattern: /\bselected_scoped_article_import\b/iu},
  {label: 'window row number', pattern: /\brow_number\s*\(/iu},
  {label: 'offset pagination', pattern: /\boffset\b/iu},
  {label: 'raw article table scan', pattern: /\b(from|join)\s+app\.article\b/iu},
  {label: 'raw judgment table scan', pattern: /\b(from|join)\s+app\.judgment(?:\b|_)/iu},
  {label: 'json extraction', pattern: /\bjson_extract(?:_string)?\s*\(/iu},
  {label: 'foreground aggregation', pattern: /\bgroup\s+by\b/iu},
]

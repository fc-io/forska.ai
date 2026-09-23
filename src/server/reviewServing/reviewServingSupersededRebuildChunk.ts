import {getSqlLiteral} from '../services/appQueryHelpers.ts'

export const supersededRetiredSnapshotRebuildChunkLastError = 'superseded by retired review-serving snapshot'

const getColumnPrefix = (tableAlias?: string) => {
  return tableAlias ? `${tableAlias}.` : ''
}

const getSupersededLastErrorPredicateSql = (tableAlias?: string) => {
  return `starts_with(COALESCE(${getColumnPrefix(tableAlias)}last_error, ''), ${getSqlLiteral(supersededRetiredSnapshotRebuildChunkLastError)})`
}

export const getReviewServingRebuildChunkBuiltPredicateSql = (tableAlias?: string) => {
  const source = getColumnPrefix(tableAlias)

  return `(
    ${source}status = 'completed'
    AND NOT ${getSupersededLastErrorPredicateSql(tableAlias)}
  )`
}

export const getReviewServingRebuildChunkUnstartedSupersededPredicateSql = (tableAlias?: string) => {
  const source = getColumnPrefix(tableAlias)

  return `(
    ${source}status = 'completed'
    AND ${source}started_at IS NULL
    AND ${getSupersededLastErrorPredicateSql(tableAlias)}
  )`
}

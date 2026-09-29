import {getSqlLiteral} from '../services/appQueryHelpers.ts'

export const supersededRetiredSnapshotRebuildChunkLastError = 'superseded by retired review-serving snapshot'

// A failed request whose last error starts with one of these was closed for good: superseded by newer work, coalesced
// into a train, or closed because it can never do useful work. Nothing readmits it, waits on it or keeps its snapshots.
const closedReviewServingRebuildRequestLastErrorPrefixes = ['superseded', 'coalesced'] as const

const getColumnPrefix = (tableAlias?: string) => {
  return tableAlias ? `${tableAlias}.` : ''
}

export const getReviewServingClosedRebuildRequestLastErrorSql = (requestAlias: string) => {
  return `(${closedReviewServingRebuildRequestLastErrorPrefixes
    .map((prefix) => {
      return `starts_with(COALESCE(${requestAlias}.last_error, ''), ${getSqlLiteral(prefix)})`
    })
    .join(' OR ')})`
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

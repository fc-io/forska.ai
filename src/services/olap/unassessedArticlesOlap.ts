import {
  getUnassessedArticlesFromClickHouse,
  getUnassessedCountFromClickHouse,
  getUnassessedPairsFromClickHouse,
} from '../clickhouse/unassessedArticlesClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {rejectDuckdbNotImplemented} from './rejectDuckdbNotImplemented.ts'

export const getUnassessedCountFromOlap = (
  params: Parameters<typeof getUnassessedCountFromClickHouse>[0],
): ReturnType<typeof getUnassessedCountFromClickHouse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('getUnassessedCount')
    : getUnassessedCountFromClickHouse(params)
}

export const getUnassessedArticlesFromOlap = (
  params: Parameters<typeof getUnassessedArticlesFromClickHouse>[0],
): ReturnType<typeof getUnassessedArticlesFromClickHouse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('getUnassessedArticles')
    : getUnassessedArticlesFromClickHouse(params)
}

export const getUnassessedPairsFromOlap = (
  params: Parameters<typeof getUnassessedPairsFromClickHouse>[0],
): ReturnType<typeof getUnassessedPairsFromClickHouse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('getUnassessedPairs')
    : getUnassessedPairsFromClickHouse(params)
}

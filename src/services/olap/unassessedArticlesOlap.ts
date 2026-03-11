import {
  getUnassessedArticlesFromClickHouse,
  getUnassessedCountFromClickHouse,
  getUnassessedPairsFromClickHouse,
} from '../clickhouse/unassessedArticlesClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {
  getUnassessedArticlesFromSqlite,
  getUnassessedCountFromSqlite,
  getUnassessedPairsFromSqlite,
} from './sqliteOlap.ts'

export const getUnassessedCountFromOlap = (
  params: Parameters<typeof getUnassessedCountFromClickHouse>[0],
): ReturnType<typeof getUnassessedCountFromClickHouse> => {
  return getOlapDb() === 'duckdb' ? getUnassessedCountFromSqlite(params) : getUnassessedCountFromClickHouse(params)
}

export const getUnassessedArticlesFromOlap = (
  params: Parameters<typeof getUnassessedArticlesFromClickHouse>[0],
): ReturnType<typeof getUnassessedArticlesFromClickHouse> => {
  return getOlapDb() === 'duckdb'
    ? getUnassessedArticlesFromSqlite(params)
    : getUnassessedArticlesFromClickHouse(params)
}

export const getUnassessedPairsFromOlap = (
  params: Parameters<typeof getUnassessedPairsFromClickHouse>[0],
): ReturnType<typeof getUnassessedPairsFromClickHouse> => {
  return getOlapDb() === 'duckdb' ? getUnassessedPairsFromSqlite(params) : getUnassessedPairsFromClickHouse(params)
}

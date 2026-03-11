import type {NumericFilterResult} from '../../server/routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'
import type {ClickHouseFilterParams, ClickHouseFilterResult} from '../clickhouse/articlesReviewsFiltersClickHouse.ts'
import {
  getDatabaseBasedFiltersFromClickHouse,
  getNumericFiltersFromClickHouse,
} from '../clickhouse/articlesReviewsFiltersClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {getDatabaseBasedFiltersFromSqlite, getNumericFiltersFromSqlite} from './sqliteOlap.ts'

export type {ClickHouseFilterParams, ClickHouseFilterResult}

export const getDatabaseBasedFiltersFromOlap = (params: ClickHouseFilterParams): Promise<ClickHouseFilterResult[]> => {
  return getOlapDb() === 'duckdb'
    ? getDatabaseBasedFiltersFromSqlite(params)
    : getDatabaseBasedFiltersFromClickHouse(params)
}

export const getNumericFiltersFromOlap = (params: ClickHouseFilterParams): Promise<NumericFilterResult[]> => {
  return getOlapDb() === 'duckdb' ? getNumericFiltersFromSqlite(params) : getNumericFiltersFromClickHouse(params)
}

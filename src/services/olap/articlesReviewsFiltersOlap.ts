import type {ClickHouseFilterParams, ClickHouseFilterResult} from '../clickhouse/articlesReviewsFiltersClickHouse.ts'
import {
  getDatabaseBasedFiltersFromClickHouse,
  getNumericFiltersFromClickHouse,
} from '../clickhouse/articlesReviewsFiltersClickHouse.ts'

import type {NumericFilterResult} from '../../server/routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'

import {getOlapDb} from './olapDb.ts'
import {rejectDuckdbNotImplemented} from './rejectDuckdbNotImplemented.ts'

export type {ClickHouseFilterParams, ClickHouseFilterResult}

export const getDatabaseBasedFiltersFromOlap = (params: ClickHouseFilterParams): Promise<ClickHouseFilterResult[]> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('getDatabaseBasedFilters')
    : getDatabaseBasedFiltersFromClickHouse(params)
}

export const getNumericFiltersFromOlap = (params: ClickHouseFilterParams): Promise<NumericFilterResult[]> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('getNumericFilters')
    : getNumericFiltersFromClickHouse(params)
}

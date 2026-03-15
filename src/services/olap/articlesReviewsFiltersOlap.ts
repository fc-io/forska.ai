import type {NumericFilterResult} from '../../server/routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'
import {getDatabaseBasedFiltersFromDuckdb, getNumericFiltersFromDuckdb} from './duckdbOlap.ts'
import type {DatabaseFilterParams, DatabaseFilterResult} from './olapTypes.ts'

export type {DatabaseFilterParams, DatabaseFilterResult}

export const getDatabaseBasedFiltersFromOlap = (params: DatabaseFilterParams): Promise<DatabaseFilterResult[]> => {
  return getDatabaseBasedFiltersFromDuckdb(params)
}

export const getNumericFiltersFromOlap = (params: DatabaseFilterParams): Promise<NumericFilterResult[]> => {
  return getNumericFiltersFromDuckdb(params)
}

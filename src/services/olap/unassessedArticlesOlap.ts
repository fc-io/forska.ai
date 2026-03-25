import {
  getUnassessedArticlesFromDuckdb,
  getUnassessedCountFromDuckdb,
  getUnassessedPairsFromDuckdb,
} from './duckdbOlap.ts'
import type {UnassessedArticlesParams, UnassessedPairsParams, UnassessedPairsResult} from './olapTypes.ts'
import type {UnassessedCountParams} from './olapTypes.ts'

export const getUnassessedCountFromOlap = (
  params: UnassessedCountParams,
): ReturnType<typeof getUnassessedCountFromDuckdb> => {
  return getUnassessedCountFromDuckdb(params)
}

export const getUnassessedArticlesFromOlap = (
  params: UnassessedArticlesParams,
): ReturnType<typeof getUnassessedArticlesFromDuckdb> => {
  return getUnassessedArticlesFromDuckdb(params)
}

export const getUnassessedPairsFromOlap = (params: UnassessedPairsParams): Promise<UnassessedPairsResult> => {
  return getUnassessedPairsFromDuckdb(params)
}

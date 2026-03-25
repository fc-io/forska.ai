import {countArticlesReviewsFromDuckdb, queryArticlesReviewsFromDuckdb} from './duckdbOlap.ts'
import type {
  ArticlesReviewsCountParams,
  ArticlesReviewsCountResponse,
  ArticlesReviewsParams,
  ArticlesReviewsResponse,
} from './olapTypes.ts'

export const queryArticlesReviewsFromOlap = (params: ArticlesReviewsParams): Promise<ArticlesReviewsResponse> => {
  return queryArticlesReviewsFromDuckdb(params)
}

export const countArticlesReviewsFromOlap = (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  return countArticlesReviewsFromDuckdb(params)
}

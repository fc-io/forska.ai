import type {
  ArticlesReviewsCountParams,
  ArticlesReviewsCountResponse,
  ArticlesReviewsParams,
  ArticlesReviewsResponse,
} from '../clickhouse/articlesReviewsClickHouse.ts'
import {
  countArticlesReviewsFromClickHouse,
  queryArticlesReviewsFromClickHouse,
} from '../clickhouse/articlesReviewsClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {rejectDuckdbNotImplemented} from './rejectDuckdbNotImplemented.ts'

export const queryArticlesReviewsFromOlap = (params: ArticlesReviewsParams): Promise<ArticlesReviewsResponse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('queryArticlesReviews')
    : queryArticlesReviewsFromClickHouse(params)
}

export const countArticlesReviewsFromOlap = (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('countArticlesReviews')
    : countArticlesReviewsFromClickHouse(params)
}

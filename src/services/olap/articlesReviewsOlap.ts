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
import {countArticlesReviewsFromSqlite, queryArticlesReviewsFromSqlite} from './sqliteOlap.ts'

export const queryArticlesReviewsFromOlap = (params: ArticlesReviewsParams): Promise<ArticlesReviewsResponse> => {
  return getOlapDb() === 'duckdb' ? queryArticlesReviewsFromSqlite(params) : queryArticlesReviewsFromClickHouse(params)
}

export const countArticlesReviewsFromOlap = (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  return getOlapDb() === 'duckdb' ? countArticlesReviewsFromSqlite(params) : countArticlesReviewsFromClickHouse(params)
}

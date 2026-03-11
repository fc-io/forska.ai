import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
} from '../clickhouse/articlesReviewsBothClickHouse.ts'
import {queryArticlesReviewsBothFromClickHouse} from '../clickhouse/articlesReviewsBothClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {queryArticlesReviewsBothFromSqlite} from './sqliteOlap.ts'

export const queryArticlesReviewsBothFromOlap = (
  params: ArticlesReviewsBothParams,
): Promise<ArticlesReviewsBothResponse> => {
  return getOlapDb() === 'duckdb'
    ? queryArticlesReviewsBothFromSqlite(params)
    : queryArticlesReviewsBothFromClickHouse(params)
}

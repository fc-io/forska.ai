import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
} from '../clickhouse/articlesReviewsBothClickHouse.ts'
import {queryArticlesReviewsBothFromClickHouse} from '../clickhouse/articlesReviewsBothClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {rejectDuckdbNotImplemented} from './rejectDuckdbNotImplemented.ts'

export const queryArticlesReviewsBothFromOlap = (
  params: ArticlesReviewsBothParams,
): Promise<ArticlesReviewsBothResponse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('queryArticlesReviewsBoth')
    : queryArticlesReviewsBothFromClickHouse(params)
}

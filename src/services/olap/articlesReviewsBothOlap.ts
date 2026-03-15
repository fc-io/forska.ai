import {queryArticlesReviewsBothFromDuckdb} from './duckdbOlap.ts'
import type {ArticlesReviewsBothParams, ArticlesReviewsBothResponse} from './olapTypes.ts'

export const queryArticlesReviewsBothFromOlap = (
  params: ArticlesReviewsBothParams,
): Promise<ArticlesReviewsBothResponse> => {
  return queryArticlesReviewsBothFromDuckdb(params)
}

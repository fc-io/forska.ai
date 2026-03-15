import {selectArticleIdsByFilterDuckdb} from './duckdbOlap.ts'
import type {SelectArticleIdsArgs} from './olapTypes.ts'

export const selectArticleIdsByFilterOlap = (
  ...args: SelectArticleIdsArgs
): ReturnType<typeof selectArticleIdsByFilterDuckdb> => {
  return selectArticleIdsByFilterDuckdb(...args)
}

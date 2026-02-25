import {selectArticleIdsByFilterClickHouse} from '../clickhouse/selectArticleIdsClickHouse.ts'

import {getOlapDb} from './olapDb.ts'
import {rejectDuckdbNotImplemented} from './rejectDuckdbNotImplemented.ts'

export const selectArticleIdsByFilterOlap = (
  ...args: Parameters<typeof selectArticleIdsByFilterClickHouse>
): ReturnType<typeof selectArticleIdsByFilterClickHouse> => {
  return getOlapDb() === 'duckdb'
    ? rejectDuckdbNotImplemented('selectArticleIdsByFilter')
    : selectArticleIdsByFilterClickHouse(...args)
}

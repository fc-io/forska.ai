import {selectArticleIdsByFilterClickHouse} from '../clickhouse/selectArticleIdsClickHouse.ts'
import {getOlapDb} from './olapDb.ts'
import {selectArticleIdsByFilterSqlite} from './sqliteOlap.ts'

export const selectArticleIdsByFilterOlap = (
  ...args: Parameters<typeof selectArticleIdsByFilterClickHouse>
): ReturnType<typeof selectArticleIdsByFilterClickHouse> => {
  return getOlapDb() === 'duckdb'
    ? selectArticleIdsByFilterSqlite(...args)
    : selectArticleIdsByFilterClickHouse(...args)
}

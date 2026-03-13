import {getSqliteClient} from './getDatabase.ts'

type SqliteTableRow = {name: string}

export const hasSqliteTable = (tableName: string) => {
  const row = getSqliteClient()
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as SqliteTableRow | null

  return row !== null
}

import {Database} from 'bun:sqlite'
import {drizzle} from 'drizzle-orm/bun-sqlite'
import {migrate} from 'drizzle-orm/bun-sqlite/migrator'
import {resolve} from 'path'

import * as schema from '../../db/schema.ts'
import {env} from './env.ts'
import {ensureSqlitePathDirectory} from './getSqlitePath.ts'

ensureSqlitePathDirectory(env.SQLITE_PATH)
const sqlite = new Database(env.SQLITE_PATH, {create: true})

sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
sqlite.exec('PRAGMA synchronous = NORMAL;')
sqlite.exec('PRAGMA busy_timeout = 5000;')

const db = drizzle({client: sqlite, schema, logger: false})
const sqliteMigrationsFolder = resolve(import.meta.dir, '../../db/sqliteMigrations')

migrate(db, {migrationsFolder: sqliteMigrationsFolder})

export type AppDatabase = typeof db

export const getDatabase = () => {
  return db
}

export const getSqliteClient = () => {
  return sqlite
}

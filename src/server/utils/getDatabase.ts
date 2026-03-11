import {Database} from 'bun:sqlite'
import {drizzle} from 'drizzle-orm/bun-sqlite'

import * as schema from '../../db/schema.ts'
import {env} from './env.ts'

const sqlite = new Database(env.SQLITE_PATH, {create: true})

sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
sqlite.exec('PRAGMA synchronous = NORMAL;')
sqlite.exec('PRAGMA busy_timeout = 5000;')

const db = drizzle({client: sqlite, schema, logger: false})

export type AppDatabase = typeof db

export const getDatabase = () => {
  return db
}

export const getSqliteClient = () => {
  return sqlite
}

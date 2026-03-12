import {migrate} from 'drizzle-orm/bun-sqlite/migrator'
import {resolve} from 'path'

import {env} from '../server/utils/env.ts'
import {getDatabase} from '../server/utils/getDatabase.ts'

const migrateSqlite = async (): Promise<void> => {
  const migrationsFolder = resolve(import.meta.dir, 'sqliteMigrations')

  console.log(`[db:mig] sqlite path: ${env.SQLITE_PATH}`)
  console.log(`[db:mig] migrations folder: ${migrationsFolder}`)

  migrate(getDatabase(), {migrationsFolder})

  console.log('[db:mig] SQLite migrations applied successfully')
}

void migrateSqlite()

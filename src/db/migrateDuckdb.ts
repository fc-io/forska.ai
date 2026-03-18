import {readdirSync, readFileSync} from 'fs'
import {resolve} from 'path'

import {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../server/utils/duckdbScriptAccess.ts'
import {env} from '../server/utils/env.ts'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')

const getDuckdbMigrationFiles = (folder: string) => {
  return readdirSync(folder)
    .filter((fileName) => {
      return fileName.endsWith('.sql')
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

const ensureDuckdbMigrationsTable = async () => {
  await getAppDatabaseService().run(`
    CREATE TABLE IF NOT EXISTS app_schema_migration (
      name VARCHAR PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

const getAppliedDuckdbMigrationNames = async () => {
  const rows = await getAppDatabaseService().queryJson<{name: string}>(`
    SELECT name
    FROM app_schema_migration
    ORDER BY name ASC
  `)

  return new Set(
    rows.map((row) => {
      return row.name
    }),
  )
}

const applyDuckdbMigrationFile = async (fileName: string) => {
  const filePath = resolve(migrationsFolder, fileName)
  const sqlText = readFileSync(filePath, 'utf8').trim()

  if (sqlText === '') {
    return
  }

  try {
    await getAppDatabaseService().run('BEGIN TRANSACTION')
    await getAppDatabaseService().run(sqlText)
    await getAppDatabaseService().run(`
      INSERT INTO app_schema_migration (name)
      VALUES ('${escapeSqlString(fileName)}')
    `)
    await getAppDatabaseService().run('COMMIT')
  } catch (error) {
    await getAppDatabaseService().run('ROLLBACK')
    throw error
  }
}

const applyDuckdbMigrationFiles = async (fileNames: string[], appliedNames: Set<string>): Promise<void> => {
  if (fileNames.length === 0) {
    return
  }

  const [currentFileName = ''] = fileNames

  if (!appliedNames.has(currentFileName)) {
    console.log(`[db:duck:mig] applying ${currentFileName}`)
    await applyDuckdbMigrationFile(currentFileName)
  }

  return applyDuckdbMigrationFiles(fileNames.slice(1), appliedNames)
}

export const migrateDuckdb = async (): Promise<void> => {
  const migrationFiles = getDuckdbMigrationFiles(migrationsFolder)

  console.log(`[db:duck:mig] duckdb path: ${env.DUCKDB_PATH}`)
  console.log(`[db:duck:mig] migrations folder: ${migrationsFolder}`)

  await ensureDuckdbMigrationsTable()
  await applyDuckdbMigrationFiles(migrationFiles, await getAppliedDuckdbMigrationNames())

  console.log('[db:duck:mig] DuckDB migrations applied successfully')
}

const closeAppDatabaseService = async () => {
  await getAppDatabaseService().close()
}

const runDuckdbMigrationScript = async () => {
  await withDuckdbMaintenanceAccess('duckdb migration', async () => {
    await migrateDuckdb()
    await closeAppDatabaseService()
  })
}

if (import.meta.main) {
  void runDuckdbMigrationScript().catch(async (error) => {
    await closeAppDatabaseService()
    throw error
  })
}

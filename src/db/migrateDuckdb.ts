import {readdirSync, readFileSync} from 'fs'
import {resolve} from 'path'

import {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../server/utils/duckdbScriptAccess.ts'
import {getEnv} from '../server/utils/env.ts'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')

const nonTransactionalDuckdbMigrationFiles = new Set([
  '0013_rebuildArticleWithoutOpenalexId.sql',
  '0021_rebuildModelWithProviderConnections.sql',
  '0040_projectPromptCriteriaDispositionCombined.sql',
  '0059_projectMartDirtyMaterializationState.sql',
  '0076_comparisonServingHumanLlmTrueConflictFilter.sql',
  '0077_comparisonServingHumanLlmOverlapFilter.sql',
])

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

const getNormalizedDuckdbMigrationError = (error: unknown) => {
  return error instanceof Error ? error : new Error(String(error))
}

const isDuckdbMigrationNoActiveTransactionError = (error: unknown) => {
  return getNormalizedDuckdbMigrationError(error).message.includes('cannot rollback - no transaction is active')
}

const getChainedDuckdbMigrationError = (error: unknown, nextError: unknown, context: string) => {
  const normalizedError = getNormalizedDuckdbMigrationError(error)
  const normalizedNextError = getNormalizedDuckdbMigrationError(nextError)
  const combinedMessage =
    normalizedNextError.message === normalizedError.message
      ? normalizedError.message
      : `${normalizedError.message} -- ${context}: ${normalizedNextError.message}`

  return combinedMessage === normalizedError.message ? normalizedError : new Error(combinedMessage)
}

const getDuckdbMigrationRollbackError = async () => {
  try {
    await getAppDatabaseService().run('ROLLBACK')
    return null
  } catch (error) {
    return getNormalizedDuckdbMigrationError(error)
  }
}

const insertDuckdbMigrationName = async (fileName: string) => {
  await getAppDatabaseService().run(`
    INSERT INTO app_schema_migration (name)
    VALUES ('${escapeSqlString(fileName)}')
  `)
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

  if (nonTransactionalDuckdbMigrationFiles.has(fileName)) {
    await getAppDatabaseService().run(sqlText)
    return insertDuckdbMigrationName(fileName)
  }

  try {
    await getAppDatabaseService().run('BEGIN TRANSACTION')
    await getAppDatabaseService().run(sqlText)
    await insertDuckdbMigrationName(fileName)
    await getAppDatabaseService().run('COMMIT')
  } catch (error) {
    const rollbackError = await getDuckdbMigrationRollbackError()

    if (rollbackError !== null && !isDuckdbMigrationNoActiveTransactionError(rollbackError)) {
      throw getChainedDuckdbMigrationError(error, rollbackError, 'rollback failed')
    }

    throw getNormalizedDuckdbMigrationError(error)
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
  const env = getEnv()

  console.log(`[db:duck:mig] duckdb path: ${env.DUCKDB_PATH}`)
  console.log(`[db:duck:mig] migrations folder: ${migrationsFolder}`)

  await ensureDuckdbMigrationsTable()
  await applyDuckdbMigrationFiles(migrationFiles, await getAppliedDuckdbMigrationNames())
  await getAppDatabaseService().maintenance('checkpoint')

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

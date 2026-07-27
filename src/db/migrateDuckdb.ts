import {readdirSync, readFileSync} from 'fs'
import {resolve} from 'path'

import {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {parseDuckdbMemoryLimitToMiB} from '../server/utils/duckdbMemoryLimit.ts'
import {withDuckdbMaintenanceAccess} from '../server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../server/utils/duckdbService.ts'
import {getEnv} from '../server/utils/env.ts'

const migrationsFolder = resolve(import.meta.dir, 'duckdbMigrations')
const workloadContext = getMaintenanceDuckdbWorkloadContext('migrateDuckdb')
const lowMemoryMigrationCheckpointThreshold = '1KiB'

const nonTransactionalDuckdbMigrationFiles = new Set([
  '0013_rebuildArticleWithoutOpenalexId.sql',
  '0021_rebuildModelWithProviderConnections.sql',
  '0040_projectPromptCriteriaDispositionCombined.sql',
  '0059_projectMartDirtyMaterializationState.sql',
  '0076_comparisonServingHumanLlmTrueConflictFilter.sql',
  '0077_comparisonServingHumanLlmOverlapFilter.sql',
  '0090_comparisonServingAnswerFilterBooleans.sql',
  '0095_comparisonServingLlmTrueDifferenceFilter.sql',
  '0183_backfillReviewArticleServingListModeStateFilters.sql',
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
    await getAppDatabaseService().run('ROLLBACK', workloadContext)
    return null
  } catch (error) {
    return getNormalizedDuckdbMigrationError(error)
  }
}

const recoverReviewArticleListModeStateMigration = async () => {
  const rows = await getAppDatabaseService().queryJson<{tableName: string}>(
    `
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = 'mart'
      AND table_name IN (
        'review_article_serving_list_mode_state_v4',
        'review_article_serving_list_mode_state_v4_repair'
      )
  `,
    workloadContext,
  )
  const tableNames = new Set(
    rows.map((row) => {
      return row.tableName
    }),
  )

  if (
    !tableNames.has('review_article_serving_list_mode_state_v4')
    && tableNames.has('review_article_serving_list_mode_state_v4_repair')
  ) {
    await getAppDatabaseService().run(
      'ALTER TABLE mart.review_article_serving_list_mode_state_v4_repair RENAME TO review_article_serving_list_mode_state_v4',
      workloadContext,
    )
  }
}

const insertDuckdbMigrationName = async (fileName: string) => {
  await getAppDatabaseService().run(
    `
    INSERT INTO app_schema_migration (name)
    VALUES ('${escapeSqlString(fileName)}')
  `,
    workloadContext,
  )
}

const ensureDuckdbMigrationsTable = async () => {
  await getAppDatabaseService().run(
    `
    CREATE TABLE IF NOT EXISTS app_schema_migration (
      name VARCHAR PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `,
    workloadContext,
  )
}

const getAppliedDuckdbMigrationNames = async () => {
  const rows = await getAppDatabaseService().queryJson<{name: string}>(
    `
    SELECT name
    FROM app_schema_migration
    ORDER BY name ASC
  `,
    workloadContext,
  )

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
    if (fileName === '0183_backfillReviewArticleServingListModeStateFilters.sql') {
      await recoverReviewArticleListModeStateMigration()
    }

    await getAppDatabaseService().run(sqlText, workloadContext)
    return insertDuckdbMigrationName(fileName)
  }

  try {
    await getAppDatabaseService().run('BEGIN TRANSACTION', workloadContext)
    await getAppDatabaseService().run(sqlText, workloadContext)
    await insertDuckdbMigrationName(fileName)
    await getAppDatabaseService().run('COMMIT', workloadContext)
  } catch (error) {
    const rollbackError = await getDuckdbMigrationRollbackError()

    if (rollbackError !== null && !isDuckdbMigrationNoActiveTransactionError(rollbackError)) {
      throw getChainedDuckdbMigrationError(error, rollbackError, 'rollback failed')
    }

    throw getNormalizedDuckdbMigrationError(error)
  }
}

const applyDuckdbMigrationFiles = async (fileNames: string[], appliedNames: Set<string>): Promise<number> => {
  if (fileNames.length === 0) {
    return 0
  }

  const [currentFileName = ''] = fileNames

  if (!appliedNames.has(currentFileName)) {
    console.log(`[db:duck:mig] applying ${currentFileName}`)
    await applyDuckdbMigrationFile(currentFileName)
    return 1 + (await applyDuckdbMigrationFiles(fileNames.slice(1), appliedNames))
  }

  return applyDuckdbMigrationFiles(fileNames.slice(1), appliedNames)
}

const shouldCheckpointAfterDuckdbMigration = (duckdbMemoryLimit: string) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(duckdbMemoryLimit)

  return memoryLimitMiB === null || memoryLimitMiB > 6400
}

const setDuckdbMigrationCheckpointThreshold = async (checkpointThreshold: string) => {
  await getAppDatabaseService().run(
    `SET checkpoint_threshold = '${escapeSqlString(checkpointThreshold)}'`,
    workloadContext,
  )
}

const applyPendingDuckdbMigrations = async (migrationFiles: string[]) => {
  await ensureDuckdbMigrationsTable()
  return applyDuckdbMigrationFiles(migrationFiles, await getAppliedDuckdbMigrationNames())
}

const applyLowMemoryDuckdbMigrations = async (migrationFiles: string[]) => {
  const configuredCheckpointThreshold = getAppDatabaseService().getRuntimeConfig().checkpointThreshold

  await setDuckdbMigrationCheckpointThreshold(lowMemoryMigrationCheckpointThreshold)

  try {
    return await applyPendingDuckdbMigrations(migrationFiles)
  } finally {
    await setDuckdbMigrationCheckpointThreshold(configuredCheckpointThreshold)
  }
}

export const migrateDuckdb = async (): Promise<void> => {
  const migrationFiles = getDuckdbMigrationFiles(migrationsFolder)
  const env = getEnv()

  console.log(`[db:duck:mig] duckdb path: ${env.DUCKDB_PATH}`)
  console.log(`[db:duck:mig] migrations folder: ${migrationsFolder}`)

  const shouldUseLowMemoryCheckpointing = !shouldCheckpointAfterDuckdbMigration(env.DUCKDB_MEMORY_LIMIT)
  const appliedMigrationCount = shouldUseLowMemoryCheckpointing
    ? await applyLowMemoryDuckdbMigrations(migrationFiles)
    : await applyPendingDuckdbMigrations(migrationFiles)

  if (appliedMigrationCount > 0 && shouldCheckpointAfterDuckdbMigration(env.DUCKDB_MEMORY_LIMIT)) {
    await getAppDatabaseService().maintenance('checkpoint', workloadContext)
  }

  console.log('[db:duck:mig] DuckDB migrations applied successfully')
}

const closeAppDatabaseService = async () => {
  await getAppDatabaseService().close({checkpointBeforeClose: false})
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

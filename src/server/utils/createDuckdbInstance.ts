import type {DuckDBInstance} from '@duckdb/node-api'

import {type DuckdbEngineIdentity, duckdbExpectedEngineIdentity} from './duckdbEngineContract.ts'

type CreateDuckdbInstanceInput = {
  create: typeof DuckDBInstance.create
  databasePath?: string
  options?: Record<string, string>
  expectedEngine?: DuckdbEngineIdentity
}

export const createDuckdbInstance = async ({
  create,
  databasePath,
  options,
  expectedEngine = duckdbExpectedEngineIdentity,
}: CreateDuckdbInstanceInput) => {
  const persistent = databasePath !== undefined && databasePath !== '' && databasePath !== ':memory:'
  const readOnly = options?.access_mode?.toUpperCase() === 'READ_ONLY'
  const bootstrapOptions = {...options}

  if (persistent && readOnly) {
    bootstrapOptions.access_mode = 'READ_WRITE'
  }

  const instance = await create(persistent ? ':memory:' : databasePath, bootstrapOptions)

  try {
    const connection = await instance.connect()

    try {
      const identity = (await connection.runAndReadAll('PRAGMA version')).getRowObjectsJson()
      const version = identity[0]?.library_version
      const sourceId = identity[0]?.source_id
      const actualVersion = typeof version === 'string' ? version : 'unknown'
      const actualSourceId = typeof sourceId === 'string' ? sourceId : 'unknown'

      if (
        identity.length !== 1
        || actualVersion !== expectedEngine.version
        || actualSourceId !== expectedEngine.sourceId
      ) {
        throw new Error(
          `Forska requires DuckDB ${expectedEngine.version} (source ${expectedEngine.sourceId}), `
            + `but loaded ${actualVersion} (source ${actualSourceId}). `
            + 'Stop the app and run bun install --frozen-lockfile from the updated checkout. '
            + 'For a packaged desktop app, reinstall the matching release. The database was not opened.',
        )
      }

      if (persistent) {
        const bootstrapCatalog = `__forska_bootstrap_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
        const databaseLiteral = `'${databasePath.replaceAll("'", "''")}'`
        const attachOptions = readOnly ? 'TYPE DUCKDB, READ_ONLY' : 'TYPE DUCKDB'

        await connection.run(`ATTACH ':memory:' AS "${bootstrapCatalog}"`)
        await connection.run(`USE "${bootstrapCatalog}"`)
        await connection.run('DETACH memory')
        await connection.run(`ATTACH ${databaseLiteral} (${attachOptions})`)

        const databases = (
          await connection.runAndReadAll(
            `SELECT database_name FROM duckdb_databases() WHERE NOT internal AND database_name <> '${bootstrapCatalog}'`,
          )
        ).getRowObjectsJson()
        const databaseName = databases[0]?.database_name

        if (databases.length !== 1 || typeof databaseName !== 'string') {
          throw new Error(`DuckDB did not attach exactly one persistent database: ${databasePath}`)
        }

        await connection.run(`USE "${databaseName.replaceAll('"', '""')}"`)
        await connection.run(`DETACH "${bootstrapCatalog}"`)
      }
    } catch (error) {
      try {
        connection.closeSync()
      } catch (closeError) {
        void closeError
      }

      throw error
    }

    connection.closeSync()
  } catch (error) {
    try {
      instance.closeSync()
    } catch (closeError) {
      void closeError
    }

    throw error
  }

  return instance
}

import type {DuckDBInstance} from '@duckdb/node-api'

type CreateDuckdbInstanceInput = {
  create: typeof DuckDBInstance.create
  databasePath?: string
  options?: Record<string, string>
}

export const createDuckdbInstance = async ({create, databasePath, options}: CreateDuckdbInstanceInput) => {
  if (databasePath === undefined || databasePath === '' || databasePath === ':memory:') {
    return create(databasePath, options)
  }

  const readOnly = options?.access_mode?.toUpperCase() === 'READ_ONLY'
  const bootstrapOptions = {...options}

  if (readOnly) {
    bootstrapOptions.access_mode = 'READ_WRITE'
  }

  const instance = await create(':memory:', bootstrapOptions)

  try {
    const connection = await instance.connect()

    try {
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

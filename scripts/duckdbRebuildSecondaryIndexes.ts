import {writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

// Drops and recreates CREATE INDEX indexes; PRIMARY KEY and UNIQUE constraint indexes are left alone.
// A secondary ART index that lost rows makes any later UPDATE/DELETE of those rows fail at COMMIT with
// "Failed to delete all rows from index", which invalidates the database. Run with the server stack stopped.
const workloadContext = getMaintenanceDuckdbWorkloadContext('duckdbRebuildSecondaryIndexes')

type SecondaryIndex = {indexName: string; schemaName: string; sql: string; tableName: string}

const getArgValue = (name: string) => {
  const argument = process.argv.slice(2).find((value) => {
    return value.startsWith(`${name}=`)
  })

  return argument?.slice(name.length + 1).trim()
}

const getTableFilter = () => {
  const tables = getArgValue('--tables')

  return tables
    ? new Set(
        tables.split(',').map((table) => {
          return table.trim()
        }),
      )
    : null
}

const getSecondaryIndexes = async () => {
  const tableFilter = getTableFilter()
  const indexes = await getAppDatabaseService().queryJson<SecondaryIndex>(
    `
      SELECT schema_name AS schemaName, table_name AS tableName, index_name AS indexName, sql
      FROM duckdb_indexes()
      WHERE sql IS NOT NULL
      ORDER BY schema_name, table_name, index_name
    `,
    workloadContext,
  )

  return indexes.filter((index) => {
    return tableFilter === null || tableFilter.has(`${index.schemaName}.${index.tableName}`)
  })
}

const rebuildSecondaryIndex = async (index: SecondaryIndex) => {
  const startedAt = Date.now()

  await getAppDatabaseService().run(`DROP INDEX "${index.schemaName}"."${index.indexName}"`, workloadContext)
  await getAppDatabaseService().run(index.sql, workloadContext)
  console.log(`rebuilt ${index.schemaName}.${index.tableName} ${index.indexName} in ${Date.now() - startedAt} ms`)
}

const runDuckdbRebuildSecondaryIndexes = async () => {
  await withDuckdbMaintenanceAccess('duckdb rebuild secondary indexes', async () => {
    const indexes = await getSecondaryIndexes()
    const recoveryPath = join(tmpdir(), `forska-secondary-indexes-${Date.now()}.sql`)

    writeFileSync(
      recoveryPath,
      `${indexes
        .map((index) => {
          return index.sql
        })
        .join('\n')}\n`,
    )
    console.log(`${indexes.length} secondary indexes; CREATE statements saved to ${recoveryPath}`)

    if (process.argv.includes('--dry-run')) {
      return
    }

    await indexes.reduce(async (previous, index) => {
      await previous
      await rebuildSecondaryIndex(index)
    }, Promise.resolve())
    await getAppDatabaseService().maintenance('checkpoint', workloadContext)
    console.log('DuckDB secondary index rebuild complete')
  })
}

if (import.meta.main) {
  await runDuckdbRebuildSecondaryIndexes()
}

import {type DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {
  appliedDuckdbMigrationNamesSql,
  type DuckdbSchemaMigrationStatus,
  duckdbSchemaMigrationTableCountSql,
  getDuckdbMigrationFileNames,
  getDuckdbSchemaAheadWarning,
  getDuckdbSchemaBehindAllowedWarning,
  getDuckdbSchemaBehindMessage,
  getDuckdbSchemaMigrationStatus,
} from '../src/db/duckdbSchemaMigrationStatus.ts'
import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {createDuckdbInstance} from '../src/server/utils/createDuckdbInstance.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'
import {getReadOnlyDuckdbRuntimeOptions} from '../src/server/utils/duckdbService.ts'
import {getEnv} from '../src/server/utils/env.ts'

type SnapshotQueryRuntime = {connection: DuckDBConnection; duckdbInstance: DuckDBInstance}

const logPrefix = '[db:query:snapshot]'
const allowSchemaBehindFlag = '--allow-schema-behind'

const getSqlArg = () => {
  const sqlArg = process.argv.slice(2).find((argument) => {
    return argument.startsWith('--sql=')
  })

  return sqlArg?.slice('--sql='.length).trim() ?? ''
}

const ensureSqlArg = () => {
  const sql = getSqlArg()

  if (sql === '') {
    throw new Error(
      'Missing --sql argument. Example: bun run db:query:snapshot -- --sql="SELECT COUNT(*) FROM app.article"',
    )
  }

  return sql
}

const deleteSnapshot = (snapshot: AppDatabaseSnapshot) => {
  return Effect.tryPromise(() => {
    return getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.sync(() => {
        console.error('[db:query:snapshot] failed to delete snapshot', {error, snapshotPath: snapshot.snapshotPath})
      })
    }),
  )
}

const getSnapshotQueryRuntime = async (snapshotPath: string): Promise<SnapshotQueryRuntime> => {
  const duckdbInstance = await createDuckdbInstance({
    create: DuckDBInstance.create.bind(DuckDBInstance),
    databasePath: snapshotPath,
    options: getReadOnlyDuckdbRuntimeOptions(),
  })
  const connection = await duckdbInstance.connect()

  return {connection, duckdbInstance}
}

const closeSnapshotQueryRuntime = (runtime: SnapshotQueryRuntime) => {
  return Effect.sync(() => {
    runtime.connection.closeSync()
    runtime.duckdbInstance.closeSync()
  })
}

const getAppliedMigrationNames = async (connection: DuckDBConnection) => {
  const [tableCountRow] = (await connection.runAndReadAll(duckdbSchemaMigrationTableCountSql)).getRowObjectsJson()
  const hasMigrationTable = Number(tableCountRow?.tableCount ?? 0) > 0
  const nameRows = hasMigrationTable
    ? ((await connection.runAndReadAll(appliedDuckdbMigrationNamesSql)).getRowObjectsJson() as Array<{name: string}>)
    : []

  return nameRows.map((row) => {
    return row.name
  })
}

const getSnapshotSchemaMigrationStatus = async (connection: DuckDBConnection) => {
  return getDuckdbSchemaMigrationStatus({
    appliedMigrationNames: await getAppliedMigrationNames(connection),
    repoMigrationNames: getDuckdbMigrationFileNames(),
  })
}

const warnAboutSchemaAhead = (duckdbPath: string, status: DuckdbSchemaMigrationStatus) => {
  if (status.unknownMigrationNames.length > 0) {
    console.error(getDuckdbSchemaAheadWarning({duckdbPath, logPrefix, migrationNames: status.unknownMigrationNames}))
  }
}

const canQuerySnapshotSchema = (status: DuckdbSchemaMigrationStatus, allowSchemaBehind: boolean) => {
  const duckdbPath = getEnv().DUCKDB_PATH
  const isBehind = status.missingMigrationNames.length > 0

  warnAboutSchemaAhead(duckdbPath, status)

  if (isBehind && !allowSchemaBehind) {
    console.error(getDuckdbSchemaBehindMessage({duckdbPath, logPrefix, migrationNames: status.missingMigrationNames}))
    process.exitCode = 1
  }

  if (isBehind && allowSchemaBehind) {
    console.error(
      getDuckdbSchemaBehindAllowedWarning({duckdbPath, logPrefix, migrationNames: status.missingMigrationNames}),
    )
  }

  return !isBehind || allowSchemaBehind
}

const runSql = (runtime: SnapshotQueryRuntime, sql: string) => {
  return Effect.tryPromise(async () => {
    const reader = await runtime.connection.runAndReadAll(sql)
    return JSON.stringify(reader.getRowObjectsJson())
  }).pipe(
    Effect.tap((output) => {
      return Effect.sync(() => {
        console.log(output.trim())
      })
    }),
  )
}

const runSqlWhenSchemaAllows = (runtime: SnapshotQueryRuntime, sql: string, allowSchemaBehind: boolean) => {
  return Effect.tryPromise(() => {
    return getSnapshotSchemaMigrationStatus(runtime.connection)
  }).pipe(
    Effect.flatMap((status) => {
      return canQuerySnapshotSchema(status, allowSchemaBehind) ? runSql(runtime, sql) : Effect.succeed(null)
    }),
  )
}

const runSnapshotQuery = (snapshot: AppDatabaseSnapshot, sql: string, allowSchemaBehind: boolean) => {
  return Effect.acquireRelease(
    Effect.tryPromise(() => {
      return getSnapshotQueryRuntime(snapshot.snapshotPath)
    }),
    closeSnapshotQueryRuntime,
  ).pipe(
    Effect.flatMap((runtime) => {
      return runSqlWhenSchemaAllows(runtime, sql, allowSchemaBehind)
    }),
  )
}

const runDuckdbSnapshotQuery = () => {
  const sql = ensureSqlArg()
  const allowSchemaBehind = process.argv.slice(2).includes(allowSchemaBehindFlag)

  return Effect.acquireRelease(Effect.tryPromise(createDuckdbSnapshotForCli), deleteSnapshot).pipe(
    Effect.flatMap((snapshot) => {
      return runSnapshotQuery(snapshot, sql, allowSchemaBehind)
    }),
  )
}

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(runDuckdbSnapshotQuery()))
}

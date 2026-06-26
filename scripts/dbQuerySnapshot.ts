import {DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'
import {getReadOnlyDuckdbRuntimeOptions} from '../src/server/utils/duckdbService.ts'

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

const getSnapshotQueryRuntime = async (snapshotPath: string) => {
  const duckdbInstance = await DuckDBInstance.create(snapshotPath, getReadOnlyDuckdbRuntimeOptions())
  const connection = await duckdbInstance.connect()

  return {connection, duckdbInstance}
}

const closeSnapshotQueryRuntime = (runtime: Awaited<ReturnType<typeof getSnapshotQueryRuntime>>) => {
  return Effect.sync(() => {
    runtime.connection.closeSync()
    runtime.duckdbInstance.closeSync()
  })
}

const runSnapshotQuery = (snapshot: AppDatabaseSnapshot, sql: string) => {
  return Effect.acquireRelease(
    Effect.tryPromise(() => {
      return getSnapshotQueryRuntime(snapshot.snapshotPath)
    }),
    closeSnapshotQueryRuntime,
  ).pipe(
    Effect.flatMap((runtime) => {
      return Effect.tryPromise(async () => {
        const reader = await runtime.connection.runAndReadAll(sql)
        return JSON.stringify(reader.getRowObjectsJson())
      })
    }),
    Effect.tap((output) => {
      return Effect.sync(() => {
        console.log(output.trim())
      })
    }),
  )
}

const runDuckdbSnapshotQuery = () => {
  const sql = ensureSqlArg()

  return Effect.acquireRelease(Effect.tryPromise(createDuckdbSnapshotForCli), deleteSnapshot).pipe(
    Effect.flatMap((snapshot) => {
      return runSnapshotQuery(snapshot, sql)
    }),
  )
}

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(runDuckdbSnapshotQuery()))
}

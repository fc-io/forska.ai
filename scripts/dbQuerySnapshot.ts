import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'

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
      'Missing --sql argument. Example: bun run db:query:snapshot -- --sql "SELECT COUNT(*) FROM app.article"',
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

const runSnapshotQuery = (snapshot: AppDatabaseSnapshot, sql: string) => {
  return Effect.sync(() => {
    const result = globalThis.Bun.spawnSync(['duckdb', '-readonly', '-json', snapshot.snapshotPath, sql], {
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'inherit',
    })

    if (result.exitCode !== 0) {
      throw new Error(`DuckDB snapshot query failed with exit code ${result.exitCode}`)
    }

    return result.stdout.toString()
  }).pipe(
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

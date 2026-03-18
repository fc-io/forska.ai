import {Effect} from 'effect'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'

const deleteStudioSnapshot = (snapshot: AppDatabaseSnapshot) => {
  return Effect.tryPromise(() => {
    return getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.sync(() => {
        console.error('[db:studio] failed to delete snapshot', {error, snapshotPath: snapshot.snapshotPath})
      })
    }),
  )
}

const openDuckdbStudio = (snapshot: AppDatabaseSnapshot) => {
  return Effect.tryPromise(() => {
    return globalThis.Bun.spawn(['duckdb', '-readonly', '-ui', snapshot.snapshotPath], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited
  }).pipe(
    Effect.flatMap((exitCode) => {
      return exitCode === 0 ? Effect.void : Effect.fail(new Error(`DuckDB UI exited with code ${exitCode}`))
    }),
  )
}

const runDuckdbStudio = () => {
  return Effect.acquireRelease(Effect.tryPromise(createDuckdbSnapshotForCli), deleteStudioSnapshot).pipe(
    Effect.tap((snapshot) => {
      return Effect.sync(() => {
        console.log(`[db:studio] snapshot=${snapshot.snapshotPath} createdAt=${snapshot.createdAt}`)
      })
    }),
    Effect.flatMap(openDuckdbStudio),
  )
}

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(runDuckdbStudio()))
}

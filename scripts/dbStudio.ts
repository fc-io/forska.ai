import {Effect} from 'effect'

import {duckdbStudioSnapshotPath} from '../src/server/routes/DuckdbStudioRoutes.ts'
import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {env} from '../src/server/utils/env.ts'

const getDuckdbStudioUrl = () => {
  return `http://127.0.0.1:${env.API_SERVER_PORT}${duckdbStudioSnapshotPath}`
}

const getErrorText = (error: unknown) => {
  const causeText = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : ''
  return error instanceof Error ? `${error.message}${causeText}` : String(error)
}

const isStudioServerUnavailable = (error: unknown) => {
  const errorText = getErrorText(error)
  return (
    errorText.includes('ECONNREFUSED') || errorText.includes('fetch failed') || errorText.includes('connection refused')
  )
}

const getSnapshotFromResponse = async (response: Response): Promise<AppDatabaseSnapshot> => {
  const body = (await response.json()) as {data?: AppDatabaseSnapshot; error?: string}

  if (!response.ok || !body.data) {
    throw new Error(body.error ?? `DuckDB snapshot request failed with status ${response.status}`)
  }

  return body.data
}

const createRemoteSnapshot = () => {
  return Effect.tryPromise(async () => {
    const response = await fetch(getDuckdbStudioUrl(), {method: 'POST'})
    return getSnapshotFromResponse(response)
  })
}

const createLocalSnapshot = () => {
  const service = getAppDatabaseService()

  return Effect.tryPromise(async () => {
    const snapshot = await service.createSnapshot()
    await service.close()
    return snapshot
  }).pipe(
    Effect.catchAll((error) => {
      return Effect.zipRight(
        Effect.tryPromise(() => {
          return service.close()
        }).pipe(
          Effect.catchAll(() => {
            return Effect.void
          }),
        ),
        Effect.fail(error),
      )
    }),
  )
}

const createStudioSnapshot = () => {
  return createRemoteSnapshot().pipe(
    Effect.catchAll((error) => {
      return isStudioServerUnavailable(error) ? createLocalSnapshot() : Effect.fail(error)
    }),
  )
}

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
  return Effect.acquireRelease(createStudioSnapshot(), deleteStudioSnapshot).pipe(
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

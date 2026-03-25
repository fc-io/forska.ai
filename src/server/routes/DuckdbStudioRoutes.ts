import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {canCurrentServerOwnDuckdb, getCurrentServerRole} from '../utils/serverRuntimeRole.ts'

export const duckdbStudioSnapshotPath = '/api/duckdbStudioSnapshots'

const ensureDuckdbStudioWriterRole = () => {
  if (!canCurrentServerOwnDuckdb()) {
    throw new Error(`DuckDB studio snapshots require writer role; got ${getCurrentServerRole()}`)
  }
}

export const duckdbStudioRoutes = new Elysia().use(withErrorHandler()).post(duckdbStudioSnapshotPath, async () => {
  ensureDuckdbStudioWriterRole()
  const data = await getAppDatabaseService().createSnapshot()
  return {data}
})

import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {canServerRoleOwnDuckdb} from '../utils/serverRole.ts'

export const duckdbStudioSnapshotPath = '/api/duckdbStudioSnapshots'

const ensureDuckdbStudioWriterRole = () => {
  if (!canServerRoleOwnDuckdb(env.SERVER_ROLE)) {
    throw new Error(`DuckDB studio snapshots require SERVER_ROLE=writer or dev-single; got ${env.SERVER_ROLE}`)
  }
}

export const duckdbStudioRoutes = new Elysia().use(withErrorHandler()).post(duckdbStudioSnapshotPath, async () => {
  ensureDuckdbStudioWriterRole()
  const data = await getAppDatabaseService().createSnapshot()
  return {data}
})

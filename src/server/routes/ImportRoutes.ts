import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const importRoutesListLimit = 500
const importRoutesWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  maxResultRows: importRoutesListLimit,
  routeOrJobKey: 'importRoutes.list',
  workloadClass: 'owner.product.importRoutes',
}

export const importRoutes = new Elysia().use(withErrorHandler()).use(
  new Elysia().get('/api/import-routes', async () => {
    const rows = await getAppDatabaseService().queryJson<{route: string; name: string | null}>(
      `
        SELECT route, name
        FROM app.import_route
        WHERE active = TRUE
        ORDER BY route ASC
        LIMIT ${importRoutesListLimit}
      `,
      importRoutesWorkloadContext,
    )

    return {data: rows}
  }),
)

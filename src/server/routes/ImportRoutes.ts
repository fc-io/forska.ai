import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const importRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia().get('/api/import-routes', async () => {
      const rows = await getAppDatabaseService().queryJson<{route: string; name: string | null}>(`
        SELECT route, name
        FROM app.import_route
        WHERE active = TRUE
        ORDER BY route ASC
      `)

      return {data: rows}
    }),
  )
  .use(
    new Elysia().get('/api/importroutes', async () => {
      const rows = await getAppDatabaseService().queryJson<{route: string}>(`
        SELECT route
        FROM app.import_route
        WHERE active = TRUE
        ORDER BY route ASC
      `)

      return {
        data: rows.map((r) => {
          return r.route
        }),
      }
    }),
  )

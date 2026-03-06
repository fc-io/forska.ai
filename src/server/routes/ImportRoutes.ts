import {asc, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {importRoute as importRouteTable} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const importRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia().use(requireUserAuth()).get('/api/import-routes', async () => {
      const db = getDatabase()

      const rows = await db
        .select({route: importRouteTable.route, name: importRouteTable.name})
        .from(importRouteTable)
        .where(eq(importRouteTable.active, true))
        .orderBy(asc(importRouteTable.route))

      return {data: rows}
    }),
  )
  .use(
    new Elysia().use(requireUserAuth()).get('/api/importroutes', async () => {
      const db = getDatabase()

      const rows = await db
        .select({route: importRouteTable.route})
        .from(importRouteTable)
        .where(eq(importRouteTable.active, true))
        .orderBy(asc(importRouteTable.route))

      return {
        data: rows.map((r) => {
          return r.route
        }),
      }
    }),
  )

import {asc, isNotNull} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {dataSource} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const importRoutes = new Elysia().use(withErrorHandler()).get('/api/importroutes', async () => {
  const db = getDatabase()

  const rows = await db
    .select({importRoute: dataSource.importRoute})
    .from(dataSource)
    .where(isNotNull(dataSource.importRoute))
    .groupBy(dataSource.importRoute)
    .orderBy(asc(dataSource.importRoute))

  return {
    data: rows
      .map((r) => {
        return r.importRoute
      })
      .filter((v): v is string => {
        return Boolean(v)
      }),
  }
})

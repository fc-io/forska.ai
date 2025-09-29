import {desc, eq, sql} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {user} from '../../../auth-schema'
import {dataSource, dataSourceAccess} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const dataSourcesRoutes = new Elysia().use(withErrorHandler()).get('/api/datasources', async () => {
  const db = getDatabase()

  const dataSources = await db
    .select({
      id: dataSource.id,
      title: dataSource.title,
      description: dataSource.description,
      createdAt: dataSource.createdAt,
      updatedAt: dataSource.updatedAt,
      ownerId: dataSource.ownerId,
      ownerName: user.name,
      ownerEmail: user.email,
      accessCount: sql<number>`COUNT(DISTINCT ${dataSourceAccess.userId})`.as('access_count'),
    })
    .from(dataSource)
    .leftJoin(user, eq(dataSource.ownerId, user.id))
    .leftJoin(dataSourceAccess, eq(dataSource.id, dataSourceAccess.dataSourceId))
    .groupBy(
      dataSource.id,
      dataSource.title,
      dataSource.description,
      dataSource.createdAt,
      dataSource.updatedAt,
      dataSource.ownerId,
      user.name,
      user.email,
    )
    .orderBy(desc(dataSource.createdAt))

  return {
    data: dataSources.map((entry) => {
      return {...entry, accessCount: entry.accessCount ?? 0}
    }),
  }
})

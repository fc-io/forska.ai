import {desc, eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../../auth-schema'
import {dataSource, dataSourceAccess} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const dataSourcesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/datasources', async () => {
    const db = getDatabase()

    const dataSources = await db
      .select({
        id: dataSource.id,
        title: dataSource.title,
        description: dataSource.description,
        createdAt: dataSource.createdAt,
        updatedAt: dataSource.updatedAt,
        lastImportAt: dataSource.lastImportAt,
        itemsAfterLastImport: dataSource.itemsAfterLastImport,
        importRoute: dataSource.importRoute,
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
        dataSource.lastImportAt,
        dataSource.itemsAfterLastImport,
        dataSource.importRoute,
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
  .get('/api/datasources/:id', async ({params}) => {
    const db = getDatabase()

    const [entry] = await db
      .select({
        id: dataSource.id,
        title: dataSource.title,
        description: dataSource.description,
        importRoute: dataSource.importRoute,
        lastImportAt: dataSource.lastImportAt,
        itemsAfterLastImport: dataSource.itemsAfterLastImport,
        createdAt: dataSource.createdAt,
        updatedAt: dataSource.updatedAt,
      })
      .from(dataSource)
      .where(eq(dataSource.id, params.id))
      .limit(1)

    if (!entry) {
      throw new Error('Data source not found')
    }

    return {data: entry}
  })
  .patch(
    '/api/datasources/:id',
    async ({params, body}) => {
      const db = getDatabase()

      const updateData: Partial<typeof dataSource.$inferInsert> = {updatedAt: new Date()}

      if (body.title !== undefined) updateData.title = body.title
      if (body.description !== undefined) updateData.description = body.description
      if (body.importRoute !== undefined) updateData.importRoute = body.importRoute

      const [updated] = await db.update(dataSource).set(updateData).where(eq(dataSource.id, params.id)).returning()

      if (!updated) {
        throw new Error('Data source not found')
      }

      return {data: updated}
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        importRoute: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

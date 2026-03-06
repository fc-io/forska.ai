import {desc, eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../../auth-schema'
import {dataSource, dataSourceAccess} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }
  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }
  return parsedDate
}

const dataSourceListSelection = {
  id: dataSource.id,
  title: dataSource.title,
  description: dataSource.description,
  createdAt: dataSource.createdAt,
  updatedAt: dataSource.updatedAt,
  dateFrom: dataSource.dateFrom,
  dateTo: dataSource.dateTo,
  lastImportAt: dataSource.lastImportAt,
  itemsAfterLastImport: dataSource.itemsAfterLastImport,
  importRoute: dataSource.importRoute,
  ownerId: dataSource.ownerId,
  ownerName: user.name,
  ownerEmail: user.email,
  accessCount: sql<number>`COUNT(DISTINCT ${dataSourceAccess.userId})`.as('access_count'),
}

const dataSourceListGroupBy = [
  dataSource.id,
  dataSource.title,
  dataSource.description,
  dataSource.createdAt,
  dataSource.updatedAt,
  dataSource.dateFrom,
  dataSource.dateTo,
  dataSource.lastImportAt,
  dataSource.itemsAfterLastImport,
  dataSource.importRoute,
  dataSource.ownerId,
  user.name,
  user.email,
]

export const dataSourcesRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/datasources', async () => {
    const db = getDatabase()

    const dataSources = await db
      .select(dataSourceListSelection)
      .from(dataSource)
      .leftJoin(user, eq(dataSource.ownerId, user.id))
      .leftJoin(dataSourceAccess, eq(dataSource.id, dataSourceAccess.dataSourceId))
      .where(eq(dataSource.archived, false))
      .groupBy(...dataSourceListGroupBy)
      .orderBy(desc(dataSource.createdAt))

    return {
      data: dataSources.map((entry) => {
        return {...entry, accessCount: entry.accessCount ?? 0}
      }),
    }
  })
  .get('/api/datasources/archived', async () => {
    const db = getDatabase()

    const dataSources = await db
      .select(dataSourceListSelection)
      .from(dataSource)
      .leftJoin(user, eq(dataSource.ownerId, user.id))
      .leftJoin(dataSourceAccess, eq(dataSource.id, dataSourceAccess.dataSourceId))
      .where(eq(dataSource.archived, true))
      .groupBy(...dataSourceListGroupBy)
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
        dateFrom: dataSource.dateFrom,
        dateTo: dataSource.dateTo,
      })
      .from(dataSource)
      .where(eq(dataSource.id, params.id))
      .limit(1)

    if (!entry) {
      throw new Error('Data source not found')
    }

    return {data: entry}
  })
  .post(
    '/api/datasources',
    async ({body}) => {
      const db = getDatabase()

      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      const [created] = await db
        .insert(dataSource)
        .values({
          title: body.title,
          description: body.description ?? null,
          importRoute: body.importRoute ?? null,
          dateFrom,
          dateTo,
          ownerId: body.ownerId,
        })
        .returning()

      return {data: created}
    },
    {
      body: t.Object({
        title: t.String(),
        description: t.Optional(t.String()),
        importRoute: t.Optional(t.String()),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        ownerId: t.String(),
      }),
    },
  )
  .patch(
    '/api/datasources/:id',
    async ({params, body}) => {
      const db = getDatabase()

      const updateData: Partial<typeof dataSource.$inferInsert> = {updatedAt: new Date()}

      if (body.title !== undefined) updateData.title = body.title
      if (body.description !== undefined) updateData.description = body.description
      if (body.importRoute !== undefined) updateData.importRoute = body.importRoute
      if (body.archived !== undefined) updateData.archived = body.archived
      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }
      if (parsedDateFrom !== undefined) updateData.dateFrom = parsedDateFrom
      if (parsedDateTo !== undefined) updateData.dateTo = parsedDateTo

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
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        archived: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/api/datasources/:id', async ({params}) => {
    const db = getDatabase()

    const [archived] = await db
      .update(dataSource)
      .set({archived: true, updatedAt: new Date()})
      .where(eq(dataSource.id, params.id))
      .returning({id: dataSource.id})

    if (!archived) {
      throw new Error('Data source not found')
    }

    return {success: true, id: archived.id}
  })

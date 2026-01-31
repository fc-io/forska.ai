import {format} from 'date-fns'
import {and, count, eq, gte, lte, sql} from 'drizzle-orm'

import {europePmcPprHarvest} from '../../../agent/europePmcPprHarvest.ts'
import {articleRouteLink, articles, dataSource, importRoute as importRouteTable} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {createCursorUpdater} from './dataSourcesImportCursor.ts'

type Database = ReturnType<typeof getDatabase>
type DataSourceRecord = typeof dataSource.$inferSelect

const fetchDataSourceById = async (db: Database, id: string): Promise<DataSourceRecord> => {
  const [record] = await db.select().from(dataSource).where(eq(dataSource.id, id)).limit(1)
  if (!record) {
    throw new Error('Data source not found')
  }
  return record
}

const countArticlesInRange = async (db: Database, route: string, record: DataSourceRecord): Promise<number> => {
  const linkedExists = sql`EXISTS (
    SELECT 1 FROM ${articleRouteLink} arl
    JOIN ${importRouteTable} ir ON ir.id = arl."import_route_id"
    WHERE arl."article_id" = ${articles.id} AND ir."route" = ${route}
  )`

  const base = linkedExists
  const hasFrom = Boolean(record.dateFrom)
  const hasTo = Boolean(record.dateTo)
  const where =
    hasFrom && hasTo
      ? and(
          base,
          gte(articles.articleCreatedAt, record.dateFrom as Date),
          lte(articles.articleCreatedAt, record.dateTo as Date),
        )
      : hasFrom
        ? and(base, gte(articles.articleCreatedAt, record.dateFrom as Date))
        : hasTo
          ? and(base, lte(articles.articleCreatedAt, record.dateTo as Date))
          : base
  const [countResult] = await db.select({value: count()}).from(articles).where(where)
  const rawValue = countResult?.value ?? 0
  return typeof rawValue === 'number' ? rawValue : Number(rawValue)
}

const updateDataSourceAfterImport = async (
  db: Database,
  id: string,
  importedCount: number,
): Promise<DataSourceRecord> => {
  const updatedAt = new Date()
  const [updated] = await db
    .update(dataSource)
    .set({lastImportAt: updatedAt, itemsAfterLastImport: importedCount, cursor: null, updatedAt})
    .where(eq(dataSource.id, id))
    .returning()

  if (!updated) {
    throw new Error('Data source not found')
  }

  return updated
}

export const dataSourcesImportRoutesPostEuropePmcPpr = async (body: {id: string}) => {
  const db = getDatabase()
  const record = await fetchDataSourceById(db, body.id)
  const importRoute = record.importRoute ?? '/api/datasources/import/europe-pmc-ppr'
  const fromDate = record.dateFrom ? format(record.dateFrom, 'yyyy-MM-dd') : '2020-01-01'
  const now = new Date()
  const recordToDate = record.dateTo ? new Date(record.dateTo) : now
  const toDate = recordToDate > now ? format(now, 'yyyy-MM-dd') : format(recordToDate, 'yyyy-MM-dd')
  if (!record.dateFrom) {
    console.warn('dataSourcesImportRoutesPostEuropePmcPpr – From date is good to have')
  }
  if (!record.dateTo) {
    console.warn('dataSourcesImportRoutesPostEuropePmcPpr – To date is good to have')
  }
  const saveCursor = createCursorUpdater(db, record.id)
  await europePmcPprHarvest({fromDate, toDate, importRoute, cursor: record.cursor ?? null, onCursorUpdate: saveCursor})
  const importedCount = await countArticlesInRange(db, importRoute, record)
  const updatedDataSource = await updateDataSourceAfterImport(db, record.id, importedCount)

  return {success: true, data: updatedDataSource}
}

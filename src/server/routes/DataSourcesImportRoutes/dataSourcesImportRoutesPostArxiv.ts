import {format} from 'date-fns'
import {and, count, eq, gte, lte, sql} from 'drizzle-orm'

import {startArxivHarvest} from '../../../agent/startArxivHarvest.ts'
import {articleRouteLink, articles, dataSource, importRoute as importRouteTable} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

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

  // Only count articles linked via the new import_route table
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
    .set({lastImportAt: updatedAt, itemsAfterLastImport: importedCount})
    .where(eq(dataSource.id, id))
    .returning()

  if (!updated) {
    throw new Error('Data source not found')
  }

  return updated
}

export const dataSourcesImportRoutesPostArxiv = async (body: {id: string}) => {
  const db = getDatabase()
  const record = await fetchDataSourceById(db, body.id)
  const importRoute = record.importRoute ?? '/api/datasources/import/arxiv'
  const fromDate = record.dateFrom ? format(record.dateFrom, 'yyyy-MM-dd') : '2020-01-01'
  const now = new Date()
  const recordToDate = record.dateTo ? new Date(record.dateTo) : now
  const toDate = recordToDate > now ? format(now, 'yyyy-MM-dd') : format(recordToDate, 'yyyy-MM-dd')
  if (!record.dateFrom) {
    console.warn('dataSourcesImportRoutesPostArxiv – From date is good to have')
  }
  if (!record.dateTo) {
    console.warn('dataSourcesImportRoutesPostArxiv – To date is good to have')
  }
  await startArxivHarvest({fromDate, toDate, importRoute})
  console.log('`````start count')
  const importedCount = await countArticlesInRange(db, importRoute, record)
  console.log('`````after count', importedCount)
  const updatedDataSource = await updateDataSourceAfterImport(db, record.id, importedCount)

  return {success: true, data: updatedDataSource}
}

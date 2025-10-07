import {format} from 'date-fns'
import {count, eq, isNull, or} from 'drizzle-orm'

import {pubmedHarvest} from '../../../agent/pubmedHarvest.ts'
import {articles, dataSource} from '../../../db/schema.ts'
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

const countArticles = async (db: Database, route: string | null | undefined): Promise<number> => {
  const routeToUse = route ?? '/api/datasources/import/pubmed'
  const whereClause =
    routeToUse === '/api/datasources/import/pubmed'
      ? or(eq(articles.importRoute, routeToUse), isNull(articles.importRoute))
      : eq(articles.importRoute, routeToUse)

  const [countResult] = await db.select({value: count()}).from(articles).where(whereClause)

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

export const dataSourcesImportRoutesPostPubmed = async (body: {id: string}) => {
  const db = getDatabase()
  const record = await fetchDataSourceById(db, body.id)
  const importRoute = record.importRoute ?? '/api/datasources/import/pubmed'
  console.log('###importRoute', importRoute)
  const fromDate = record.dateFrom ? format(record.dateFrom, 'yyyy-MM-dd') : '2020-01-01'
  const now = new Date()
  const recordToDate = record.dateTo ? new Date(record.dateTo) : now
  const toDate = recordToDate > now ? format(now, 'yyyy-MM-dd') : format(recordToDate, 'yyyy-MM-dd')
  if (!record.dateFrom) {
    console.warn('dataSourcesImportRoutesPostPubmed – From date is good to have')
  }
  if (!record.dateTo) {
    console.warn('dataSourcesImportRoutesPostPubmed – To date is good to have')
  }
  await pubmedHarvest({fromDate, toDate, maxResults: 100, importRoute})
  const importedCount = await countArticles(db, importRoute)
  const updatedDataSource = await updateDataSourceAfterImport(db, record.id, importedCount)

  return {success: true, data: updatedDataSource}
}

import {format} from 'date-fns'
import {count, eq} from 'drizzle-orm'

import {startArxivHarvest} from '../../../agent/startArxivHarvest.ts'
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

const countArticles = async (db: Database): Promise<number> => {
  // need to filter based on data source type
  const [countResult] = await db.select({value: count()}).from(articles)

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
  const fromDate = record.dateFrom ? format(record.dateFrom, 'yyyy-MM-dd') : '2020-01-01'
  const toDate = record.dateTo ? format(record.dateTo, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd')
  if (!fromDate) {
    console.warn('dataSourcesImportRoutesPostArxiv – From date is good to have')
  }
  if (!toDate) {
    console.warn('dataSourcesImportRoutesPostArxiv – To date is good to have')
  }
  await startArxivHarvest({fromDate, toDate, maxResults: 100})

  const importedCount = await countArticles(db)
  const updatedDataSource = await updateDataSourceAfterImport(db, record.id, importedCount)

  return {success: true, data: updatedDataSource}
}

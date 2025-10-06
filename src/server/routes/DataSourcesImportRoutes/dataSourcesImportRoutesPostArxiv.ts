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

  await startArxivHarvest({fromDate: '2025-09-22', toDate: '2025-10-05', maxResults: 100})

  const importedCount = await countArticles(db)
  const updatedDataSource = await updateDataSourceAfterImport(db, record.id, importedCount)

  return {success: true, data: updatedDataSource}
}

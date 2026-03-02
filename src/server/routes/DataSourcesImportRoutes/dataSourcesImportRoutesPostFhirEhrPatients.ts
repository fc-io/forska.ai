import {eq} from 'drizzle-orm'
import type {Context} from 'elysia'

import {fhirEhrPatientsWorkflowStoreEntries} from '../../../agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts'
import {
  deriveAssetsFolderFromFhirImportRoute,
  deriveFhirImportRouteFromAssetsFolder,
} from '../../../agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowTypes.ts'
import {dataSource} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type DataSourceRecord = typeof dataSource.$inferSelect

const fetchDataSourceById = async (id: string): Promise<DataSourceRecord | null> => {
  const db = getDatabase()
  const [record] = await db.select().from(dataSource).where(eq(dataSource.id, id)).limit(1)
  return record ?? null
}

const isValidAssetsCursor = (cursor: string | null): cursor is string => {
  const value = String(cursor ?? '').trim()
  return value.length > 0 && value.startsWith('assets/')
}

const getAssetsFolderForDataSource = (record: DataSourceRecord): string | null => {
  const fromCursor = isValidAssetsCursor(record.cursor) ? record.cursor : null
  const fromImportRoute = record.importRoute ? deriveAssetsFolderFromFhirImportRoute(record.importRoute) : null
  return fromCursor ?? fromImportRoute
}

const updateDataSourceAfterImport = async ({
  id,
  importRoute,
  itemsAfterLastImport,
}: {
  id: string
  importRoute: string
  itemsAfterLastImport: number
}): Promise<DataSourceRecord | null> => {
  const db = getDatabase()
  const updatedAt = new Date()
  const [updated] = await db
    .update(dataSource)
    .set({lastImportAt: updatedAt, itemsAfterLastImport, importRoute, updatedAt})
    .where(eq(dataSource.id, id))
    .returning()
  return updated ?? null
}

export const dataSourcesImportRoutesPostFhirEhrPatients = async ({
  body,
  set,
}: {
  body: {id: string}
  set: Context['set']
}) => {
  const record = await fetchDataSourceById(body.id)
  if (!record) {
    set.status = 404
    return {data: null, error: 'Data source not found'}
  }

  const assetsFolder = getAssetsFolderForDataSource(record)
  if (!assetsFolder) {
    set.status = 400
    return {
      data: null,
      error: 'Set importRoute to fhir:<folder> (maps to assets/<folder>) or set cursor to assets/<folder>',
    }
  }

  const importRoute = record.importRoute ?? deriveFhirImportRouteFromAssetsFolder(assetsFolder)
  const stats = await fhirEhrPatientsWorkflowStoreEntries({assetsFolder, importRoute})
  const itemsAfterLastImport = stats.patientsTotal
  const updated = await updateDataSourceAfterImport({id: record.id, importRoute, itemsAfterLastImport})
  if (!updated) {
    set.status = 404
    return {data: null, error: 'Data source not found'}
  }

  return {success: true, data: updated, stats}
}

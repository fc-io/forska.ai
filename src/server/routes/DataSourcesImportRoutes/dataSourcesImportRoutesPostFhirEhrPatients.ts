import type {Context} from 'elysia'

import {fhirEhrPatientsWorkflowStoreEntries} from '../../../agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts'
import {
  deriveAssetsFolderFromFhirImportRoute,
  deriveFhirImportRouteFromAssetsFolder,
} from '../../../agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowTypes.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'

const isValidAssetsCursor = (cursor: string | null): cursor is string => {
  const value = String(cursor ?? '').trim()
  return value.length > 0 && value.startsWith('assets/')
}

const getAssetsFolderForDataSource = (record: DataSourceRecord): string | null => {
  const fromCursor = isValidAssetsCursor(record.cursor) ? record.cursor : null
  const fromImportRoute = record.importRoute ? deriveAssetsFolderFromFhirImportRoute(record.importRoute) : null
  return fromCursor ?? fromImportRoute
}

type DataSourceRecord =
  Awaited<ReturnType<ReturnType<typeof getDataSourceQueryService>['getDataSourceById']>> extends infer T
    ? Exclude<T, null>
    : never

export const dataSourcesImportRoutesPostFhirEhrPatients = async ({
  body,
  set,
}: {
  body: {id: string}
  set: Context['set']
}) => {
  const dataSourceQueryService = getDataSourceQueryService()
  const record = await dataSourceQueryService.getDataSourceById(body.id)
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

  const importRouteFromRecord = String(record.importRoute ?? '').trim()
  const importRoute =
    importRouteFromRecord.length > 0 ? importRouteFromRecord : deriveFhirImportRouteFromAssetsFolder(assetsFolder)
  if (importRouteFromRecord.length > 0 && !importRoute.startsWith('fhir:')) {
    set.status = 400
    return {data: null, error: 'Data source importRoute must start with fhir:'}
  }
  const stats = await fhirEhrPatientsWorkflowStoreEntries({assetsFolder, importRoute})
  const itemsAfterLastImport = stats.patientsTotal
  const updated = await dataSourceQueryService.updateDataSourceAfterImport({
    id: record.id,
    importRoute,
    importedCount: itemsAfterLastImport,
  })

  return {success: true, data: updated, stats}
}

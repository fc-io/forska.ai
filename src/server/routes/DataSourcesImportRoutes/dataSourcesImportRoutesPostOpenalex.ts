import {format} from 'date-fns'

import {openalexHarvest} from '../../../agent/openalexHarvest.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {getSystemActor} from '../../utils/getSystemActor.ts'

export const dataSourcesImportRoutesPostOpenalex = async (body: {id: string}) => {
  const dataSourceQueryService = getDataSourceQueryService()
  const record = await dataSourceQueryService.getDataSourceById(body.id)
  if (!record) {
    throw new Error('Data source not found')
  }
  const importRoute = record.importRoute ?? '/api/datasources/import/openalex'
  const fromDate = record.dateFrom ? format(record.dateFrom, 'yyyy-MM-dd') : '2020-01-01'
  const now = new Date()
  const recordToDate = record.dateTo ? new Date(record.dateTo) : now
  const toDate = recordToDate > now ? format(now, 'yyyy-MM-dd') : format(recordToDate, 'yyyy-MM-dd')
  if (!record.dateFrom) {
    console.warn('dataSourcesImportRoutesPostOpenalex – From date is good to have')
  }
  if (!record.dateTo) {
    console.warn('dataSourcesImportRoutesPostOpenalex – To date is good to have')
  }
  const openalexMailto = getSystemActor().openalexMailto?.trim() ?? ''

  if (!openalexMailto) {
    throw new Error('OpenAlex mailto is missing. Set OPENALEX_MAILTO before importing.')
  }

  await openalexHarvest({fromDate, toDate, importRoute, mailto: openalexMailto})
  const importedCount = await dataSourceQueryService.countArticlesLinkedToImportRoute({
    route: importRoute,
    dateFrom: record.dateFrom,
    dateTo: record.dateTo,
  })
  const updatedDataSource = await dataSourceQueryService.updateDataSourceAfterImport({id: record.id, importedCount})

  return {success: true, data: updatedDataSource}
}

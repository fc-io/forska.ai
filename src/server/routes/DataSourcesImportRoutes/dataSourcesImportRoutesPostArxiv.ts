import {format} from 'date-fns'

import {startArxivHarvest} from '../../../agent/startArxivHarvest.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {createCursorUpdater} from './dataSourcesImportCursor.ts'

export const dataSourcesImportRoutesPostArxiv = async (body: {id: string}) => {
  const dataSourceQueryService = getDataSourceQueryService()
  const record = await dataSourceQueryService.getDataSourceById(body.id)
  if (!record) {
    throw new Error('Data source not found')
  }
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
  const saveCursor = createCursorUpdater(record.id)
  await startArxivHarvest({fromDate, toDate, importRoute, cursor: record.cursor ?? null, onCursorUpdate: saveCursor})
  console.log('`````start count')
  const importedCount = await dataSourceQueryService.countArticlesLinkedToImportRoute({
    route: importRoute,
    dateFrom: record.dateFrom,
    dateTo: record.dateTo,
  })
  console.log('`````after count', importedCount)
  const updatedDataSource = await dataSourceQueryService.updateDataSourceAfterImport({
    id: record.id,
    importedCount,
    cursor: null,
  })

  return {success: true, data: updatedDataSource}
}

import {format} from 'date-fns'

import {europePmcPprHarvest} from '../../../agent/europePmcPprHarvest.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {withDataSourceImportTrackingLease} from './dataSourceImportTrackingLease.ts'
import {createCursorUpdater} from './dataSourcesImportCursor.ts'

export const dataSourcesImportRoutesPostEuropePmcPpr = async (body: {id: string}) => {
  const dataSourceQueryService = getDataSourceQueryService()
  const record = await dataSourceQueryService.getDataSourceById(body.id)
  if (!record) {
    throw new Error('Data source not found')
  }
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
  const updatedDataSource = await withDataSourceImportTrackingLease(record, async ({assertLeaseOwned}) => {
    const saveCursor = createCursorUpdater(record.id)
    const saveCursorWithLease = async (cursor: string | null) => {
      await assertLeaseOwned()
      await saveCursor(cursor)
      await assertLeaseOwned()
    }

    await assertLeaseOwned()
    await europePmcPprHarvest({
      fromDate,
      toDate,
      importRoute,
      cursor: record.cursor ?? null,
      onCursorUpdate: saveCursorWithLease,
    })
    await assertLeaseOwned()
    const importedCount = await dataSourceQueryService.countArticlesLinkedToImportRoute({
      route: importRoute,
      dateFrom: record.dateFrom,
      dateTo: record.dateTo,
    })
    await assertLeaseOwned()

    return await dataSourceQueryService.updateDataSourceAfterImport({id: record.id, importedCount, cursor: null})
  })

  return {success: true, data: updatedDataSource}
}

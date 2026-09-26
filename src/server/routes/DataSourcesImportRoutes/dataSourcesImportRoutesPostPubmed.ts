import {format} from 'date-fns'

import {pubmedHarvest} from '../../../agent/pubmedHarvest.ts'
import {
  type DataSourceImportPageProgress,
  type DataSourceImportTrigger,
  isFreshDataSourceImportCursor,
} from '../../services/dataSourceImportStateRepository.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {withDataSourceImportTrackingLease} from './dataSourceImportTrackingLease.ts'
import {createCursorUpdater} from './dataSourcesImportCursor.ts'
import {startDataSourceImportInBackground} from './startDataSourceImportInBackground.ts'

export const dataSourcesImportRoutesPostPubmed = async (
  body: {id: string},
  options: {trigger?: DataSourceImportTrigger} = {},
) => {
  const dataSourceQueryService = getDataSourceQueryService()
  const record = await dataSourceQueryService.getDataSourceById(body.id)
  if (!record) {
    throw new Error('Data source not found')
  }
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
  await startDataSourceImportInBackground({
    dataSourceId: record.id,
    importRoute,
    startsFresh: isFreshDataSourceImportCursor(record.cursor),
    trigger: options.trigger ?? 'manual',
    runImport: async (markImportStarted) => {
      return await withDataSourceImportTrackingLease(record, async ({assertLeaseOwned}) => {
        await markImportStarted()
        const saveCursor = createCursorUpdater(record.id)
        const saveCursorWithLease = async (cursor: string | null, progress?: DataSourceImportPageProgress) => {
          await assertLeaseOwned()
          await saveCursor(cursor, progress)
          await assertLeaseOwned()
        }

        await assertLeaseOwned()
        await pubmedHarvest({
          fromDate,
          toDate,
          importRoute,
          cursor: record.cursor ?? null,
          dataSourceId: record.id,
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
    },
  })

  return {success: true, data: record}
}

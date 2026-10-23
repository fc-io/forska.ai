import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {getDataSourceReconciliationWorkRepository} from '../../services/dataSourceTrackingRepository.ts'
import {getDataSourceRow} from './getDataSourceRow.ts'
import {normalizeDataSourceRows} from './normalizeDataSourceRows.ts'
import {assertTrackingCanBeEnabled} from './trackingSupportedRoutes.ts'
import {addUtcDays, getLatestClosedUtcDay, getUtcDayStart, minDate} from './utcDays.ts'

export const dataSourcesRoutesPostTrackingReconcile = async ({params}: {params: {id: string}}) => {
  const existing = await getDataSourceRow(getAppDatabaseService(), params.id)

  if (!existing) {
    throw new Error('Data source not found')
  }

  if (!existing.trackingEnabled) {
    throw new Error('Continuous tracking is not enabled for this data source')
  }

  if (existing.archived) {
    throw new Error('Archived data sources cannot queue reconciliation work')
  }

  const dateFrom = getDateValue(existing.dateFrom)
  const dateTo = getDateValue(existing.dateTo)
  assertTrackingCanBeEnabled({
    dateFrom,
    importRoute: existing.importRoute,
    trackingEnabled: Boolean(existing.trackingEnabled),
  })

  if (!dateFrom || !existing.importRoute) {
    throw new Error('Continuous tracking is not configured for this data source')
  }

  const periodStart = getUtcDayStart(dateFrom)
  const latestClosedDay = getLatestClosedUtcDay()
  const configuredEndExclusive = dateTo ? addUtcDays(dateTo, 1) : null
  const periodEnd = configuredEndExclusive ? minDate(configuredEndExclusive, latestClosedDay) : latestClosedDay

  if (periodEnd <= periodStart) {
    throw new Error('No closed provider window is available for reconciliation')
  }

  const work = await getDataSourceReconciliationWorkRepository().scheduleWork({
    ageMonths: null,
    dataSourceId: existing.id,
    periodEnd,
    periodStart,
    route: existing.importRoute,
    runKind: 'manual_full_range',
  })
  const refreshed = (await getDataSourceRow(getAppDatabaseService(), existing.id)) ?? existing
  const [dataSource] = await normalizeDataSourceRows(getAppDatabaseService(), [refreshed])

  return {data: {dataSource, work}}
}

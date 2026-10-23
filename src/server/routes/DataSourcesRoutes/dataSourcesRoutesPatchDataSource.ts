import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createOrUpdateTrackingStateIfEnabled} from './createOrUpdateTrackingStateIfEnabled.ts'
import {getDataSourceTrackingSpoolRepositoryForRoute} from './dataSourcesRoutesPatchDataSource/dataSourceTrackingSpoolRepositoryForRoute.ts'
import {
  deleteReconciliationWorkForRemovedScheduleMonths,
  deleteReconciliationWorkForStaleRoute,
  deleteReconciliationWorkOutsideBounds,
} from './dataSourcesRoutesPatchDataSource/deleteReconciliationWork.ts'
import {areDateBoundsEqual, areNumberListsEqual} from './dataSourcesRoutesPatchDataSource/equalityChecks.ts'
import {hasMutableDataSourceChanges} from './dataSourcesRoutesPatchDataSource/hasMutableDataSourceChanges.ts'
import {resetTrackingStateAfterConfigurationChange} from './dataSourcesRoutesPatchDataSource/resetTrackingStateAfterConfigurationChange.ts'
import {getDataSourceRow} from './getDataSourceRow.ts'
import {getDataSourcesWorkloadContext} from './getDataSourcesWorkloadContext.ts'
import {normalizeDataSourceRows} from './normalizeDataSourceRows.ts'
import {parseOptionalDate} from './parseOptionalDate.ts'
import {getSafeCovidencePackageConfig, getSafeStructuredFileImportConfig} from './safeDataSourceImportConfigs.ts'
import {
  getTrackingReconcileScheduleMonths,
  getTrackingReconcileScheduleMonthsSqlLiteral,
  normalizeTrackingReconcileScheduleMonthsForWrite,
} from './trackingReconcileScheduleMonths.ts'
import {assertTrackingCanBeEnabled} from './trackingSupportedRoutes.ts'
import {updateDataSourceTx} from './updateDataSourceTx.ts'
import {getUtcDayStart} from './utcDays.ts'

export const dataSourcesRoutesPatchDataSource = async ({
  params,
  body,
}: {
  params: {id: string}
  body: {
    title?: string
    description?: string | null
    importRoute?: string | null
    dateFrom?: string | null
    dateTo?: string | null
    trackingEnabled?: boolean
    trackingReconcileScheduleMonths?: number[]
    archived?: boolean
  }
}) => {
  const existing = await getDataSourceRow(getAppDatabaseService(), params.id)

  if (!existing) {
    throw new Error('Data source not found')
  }

  if (
    (getSafeStructuredFileImportConfig(existing.cursor) || getSafeCovidencePackageConfig(existing.cursor))
    && hasMutableDataSourceChanges(body)
  ) {
    throw new Error('Imported XML/JSON data sources are immutable and can only be archived')
  }

  const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
  const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
  if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
    throw new Error('date_from must be on or before date_to')
  }
  const nextDateFrom = parsedDateFrom === undefined ? getDateValue(existing.dateFrom) : parsedDateFrom
  const nextDateTo = parsedDateTo === undefined ? getDateValue(existing.dateTo) : parsedDateTo
  if (nextDateFrom && nextDateTo && nextDateFrom > nextDateTo) {
    throw new Error('date_from must be on or before date_to')
  }
  const nextImportRoute = body.importRoute === undefined ? existing.importRoute : body.importRoute
  const nextTrackingEnabled =
    body.trackingEnabled === undefined ? Boolean(existing.trackingEnabled) : body.trackingEnabled
  const existingDateFrom = getDateValue(existing.dateFrom)
  const existingDateTo = getDateValue(existing.dateTo)
  const trackingReconcileScheduleMonths =
    body.trackingReconcileScheduleMonths === undefined
      ? undefined
      : normalizeTrackingReconcileScheduleMonthsForWrite(body.trackingReconcileScheduleMonths)
  const existingTrackingReconcileScheduleMonths = getTrackingReconcileScheduleMonths(
    existing.trackingReconcileScheduleMonths,
  )
  const nextTrackingReconcileScheduleMonths = trackingReconcileScheduleMonths ?? existingTrackingReconcileScheduleMonths
  const trackingScheduleChanged =
    trackingReconcileScheduleMonths !== undefined
    && !areNumberListsEqual(trackingReconcileScheduleMonths, existingTrackingReconcileScheduleMonths)
  const dateBoundsChanged =
    !areDateBoundsEqual(existingDateFrom, nextDateFrom) || !areDateBoundsEqual(existingDateTo, nextDateTo)
  const startBoundaryMovedEarlier = Boolean(
    existingDateFrom
    && nextDateFrom
    && getUtcDayStart(nextDateFrom).getTime() < getUtcDayStart(existingDateFrom).getTime(),
  )
  const importRouteChanged = nextImportRoute !== existing.importRoute
  assertTrackingCanBeEnabled({
    dateFrom: nextDateFrom,
    importRoute: nextImportRoute,
    trackingEnabled: nextTrackingEnabled,
  })
  const updateParts = [
    `updated_at = current_timestamp`,
    body.title !== undefined ? `title = ${getSqlLiteral(body.title)}` : null,
    body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
    body.importRoute !== undefined ? `import_route = ${getSqlLiteral(body.importRoute)}` : null,
    body.archived !== undefined ? `archived = ${body.archived ? 'TRUE' : 'FALSE'}` : null,
    parsedDateFrom !== undefined ? `date_from = ${getSqlLiteral(parsedDateFrom)}` : null,
    parsedDateTo !== undefined ? `date_to = ${getSqlLiteral(parsedDateTo)}` : null,
    body.trackingEnabled !== undefined ? `tracking_enabled = ${body.trackingEnabled ? 'TRUE' : 'FALSE'}` : null,
    body.trackingReconcileScheduleMonths !== undefined
      ? `tracking_reconcile_schedule_months = CAST(${getTrackingReconcileScheduleMonthsSqlLiteral(nextTrackingReconcileScheduleMonths)} AS JSON)`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })

  const refreshed = await getAppDatabaseService().transaction(
    async (tx) => {
      const updated = await updateDataSourceTx(tx, {dataSourceId: params.id, updateParts})

      if (!updated) {
        return null
      }

      await createOrUpdateTrackingStateIfEnabled({
        db: tx,
        dataSourceId: updated.id,
        importRoute: updated.importRoute,
        trackingEnabled: updated.trackingEnabled ?? false,
      })

      await resetTrackingStateAfterConfigurationChange(tx, {
        dataSourceId: updated.id,
        resetHighWater: startBoundaryMovedEarlier || importRouteChanged,
        resetReconciliationScheduler: dateBoundsChanged || importRouteChanged || trackingScheduleChanged,
        resetWindow: dateBoundsChanged || importRouteChanged,
      })

      if (dateBoundsChanged) {
        await deleteReconciliationWorkOutsideBounds(tx, {
          dataSourceId: updated.id,
          dateFrom: nextDateFrom,
          dateTo: nextDateTo,
        })
      }

      if (trackingScheduleChanged) {
        await deleteReconciliationWorkForRemovedScheduleMonths(tx, {
          dataSourceId: updated.id,
          scheduleMonths: nextTrackingReconcileScheduleMonths,
        })
      }

      if (importRouteChanged) {
        await deleteReconciliationWorkForStaleRoute(tx, {dataSourceId: updated.id, route: updated.importRoute})
      }

      return getDataSourceRow(tx, updated.id)
    },
    getDataSourcesWorkloadContext({operation: 'updateTransaction'}),
  )

  if (refreshed && (dateBoundsChanged || importRouteChanged || trackingScheduleChanged)) {
    getDataSourceTrackingSpoolRepositoryForRoute().rejectOpenWindowsForDataSource({
      dataSourceId: refreshed.id,
      error: 'Tracked data source configuration changed',
      now: new Date(),
    })
  }

  if (!refreshed) {
    throw new Error('Data source not found')
  }

  const [normalizedUpdated] = await normalizeDataSourceRows(getAppDatabaseService(), [refreshed])

  return {data: normalizedUpdated}
}

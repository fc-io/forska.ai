import {getDateValue} from '../../services/appQueryHelpers.ts'
import type {DataSourceImportState} from './dataSourcesRoutesTypes.ts'
import {getTrackingReconcileScheduleMonths} from './trackingReconcileScheduleMonths.ts'
import {isTrackingSupportedRoute} from './trackingSupportedRoutes.ts'

export const normalizeDataSourceRow = <TRow extends Record<string, unknown>>(
  row: TRow,
  importState: DataSourceImportState,
) => {
  const {cursor, ...safeRow} = row
  const trackingGranularity = typeof row['trackingGranularity'] === 'string' ? row['trackingGranularity'] : null
  const trackingState = trackingGranularity
    ? {
        activeCursor: typeof row['trackingActiveCursor'] === 'string' ? row['trackingActiveCursor'] : null,
        activeReconciliationAgeMonths:
          typeof row['trackingActiveReconciliationAgeMonths'] === 'number'
            ? row['trackingActiveReconciliationAgeMonths']
            : null,
        activeRunKind: typeof row['trackingActiveRunKind'] === 'string' ? row['trackingActiveRunKind'] : null,
        activeWindowEnd: getDateValue(row['trackingActiveWindowEnd']),
        activeWindowStart: getDateValue(row['trackingActiveWindowStart']),
        failureCount: typeof row['trackingFailureCount'] === 'number' ? row['trackingFailureCount'] : 0,
        granularity: trackingGranularity,
        highWaterCompletedAt: getDateValue(row['trackingHighWaterCompletedAt']),
        lastAttemptAt: getDateValue(row['trackingLastAttemptAt']),
        lastError: typeof row['trackingLastError'] === 'string' ? row['trackingLastError'] : null,
        lastReconciliationCompletedAt: getDateValue(row['trackingLastReconciliationCompletedAt']),
        lastSuccessAt: getDateValue(row['trackingLastSuccessAt']),
        nextRunAfter: getDateValue(row['trackingNextRunAfter']),
        pendingReconciliationCount:
          typeof row['trackingPendingReconciliationCount'] === 'number' ? row['trackingPendingReconciliationCount'] : 0,
      }
    : null

  return {
    ...safeRow,
    ...importState,
    createdAt: getDateValue(row['createdAt']),
    updatedAt: getDateValue(row['updatedAt']),
    dateFrom: getDateValue(row['dateFrom']),
    dateTo: getDateValue(row['dateTo']),
    lastImportAt: getDateValue(row['lastImportAt']),
    trackingEnabled: Boolean(row['trackingEnabled']),
    trackingReconcileScheduleMonths: getTrackingReconcileScheduleMonths(row['trackingReconcileScheduleMonths']),
    trackingState,
    trackingSupported: isTrackingSupportedRoute(typeof row['importRoute'] === 'string' ? row['importRoute'] : null),
  }
}

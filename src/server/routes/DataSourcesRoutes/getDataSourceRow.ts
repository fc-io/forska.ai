import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import type {AppQueryRunner, DataSourceRow} from './dataSourcesRoutesTypes.ts'
import {getDataSourcesWorkloadContext} from './getDataSourcesWorkloadContext.ts'

const getDataSourceRowSql = (dataSourceId: string) => {
  return `
    SELECT
      data_source.id,
      data_source.title,
      data_source.description,
      data_source.import_route AS importRoute,
      data_source.cursor,
      data_source.last_import_at AS lastImportAt,
      data_source.items_after_last_import AS itemsAfterLastImport,
      data_source.created_at AS createdAt,
      data_source.updated_at AS updatedAt,
      data_source.date_from AS dateFrom,
      data_source.date_to AS dateTo,
      data_source.tracking_enabled AS trackingEnabled,
      TO_JSON(data_source.tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
      tracking_state.granularity AS trackingGranularity,
      tracking_state.high_water_completed_at AS trackingHighWaterCompletedAt,
      tracking_state.active_window_start AS trackingActiveWindowStart,
      tracking_state.active_window_end AS trackingActiveWindowEnd,
      tracking_state.active_cursor AS trackingActiveCursor,
      tracking_state.last_attempt_at AS trackingLastAttemptAt,
      tracking_state.last_success_at AS trackingLastSuccessAt,
      tracking_state.next_run_after AS trackingNextRunAfter,
      tracking_state.last_reconciliation_completed_at AS trackingLastReconciliationCompletedAt,
      tracking_state.failure_count AS trackingFailureCount,
      tracking_state.last_error AS trackingLastError,
      tracking_state.active_run_kind AS trackingActiveRunKind,
      tracking_state.active_reconciliation_age_months AS trackingActiveReconciliationAgeMonths,
      COALESCE(reconciliation_work.pendingReconciliationCount, 0) AS trackingPendingReconciliationCount,
      data_source.archived
    FROM app.data_source data_source
    LEFT JOIN app.data_source_tracking_state tracking_state ON tracking_state.data_source_id = data_source.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::INTEGER AS pendingReconciliationCount
      FROM app.data_source_reconciliation_work work
      WHERE work.data_source_id = data_source.id
        AND work.status IN ('queued', 'running', 'failed')
    ) reconciliation_work ON TRUE
    WHERE data_source.id = '${escapeSqlString(dataSourceId)}'
    LIMIT 1
  `
}

export const getDataSourceRow = async (db: AppQueryRunner, dataSourceId: string) => {
  const [row] = await db.queryJson<DataSourceRow>(
    getDataSourceRowSql(dataSourceId),
    getDataSourcesWorkloadContext({maxResultRows: 1, operation: 'detail'}),
  )
  return row ?? null
}

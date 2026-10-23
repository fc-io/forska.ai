import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {DataSourceTrackingDatabaseRunner} from '../../../services/dataSourceTrackingRepository.ts'
import {getDataSourcesWorkloadContext} from '../getDataSourcesWorkloadContext.ts'

export const resetTrackingStateAfterConfigurationChange = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; resetHighWater: boolean; resetReconciliationScheduler: boolean; resetWindow: boolean},
) => {
  const setParts = [
    'updated_at = current_timestamp',
    params.resetWindow ? 'active_window_start = NULL' : null,
    params.resetWindow ? 'active_window_end = NULL' : null,
    params.resetWindow ? 'active_cursor = NULL' : null,
    params.resetWindow ? 'active_run_kind = NULL' : null,
    params.resetWindow ? 'active_reconciliation_age_months = NULL' : null,
    params.resetWindow ? 'lease_owner = NULL' : null,
    params.resetWindow ? 'lease_expires_at = NULL' : null,
    params.resetHighWater ? 'high_water_completed_at = NULL' : null,
    params.resetReconciliationScheduler ? 'last_reconciliation_scheduler_at = NULL' : null,
  ].filter((part): part is string => {
    return part !== null
  })

  if (setParts.length <= 1) {
    return
  }

  await db.run(
    `
    UPDATE app.data_source_tracking_state
    SET ${setParts.join(', ')}
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
  `,
    getDataSourcesWorkloadContext({operation: 'trackingStateConfigurationReset'}),
  )
}

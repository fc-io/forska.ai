import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {DataSourceTrackingDatabaseRunner} from '../../../services/dataSourceTrackingRepository.ts'
import {getDataSourcesWorkloadContext} from '../getDataSourcesWorkloadContext.ts'
import {addUtcDays, getUtcDayStart} from '../utcDays.ts'

export const deleteReconciliationWorkOutsideBounds = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; dateFrom: Date | null; dateTo: Date | null},
) => {
  const startBoundary = params.dateFrom ? getUtcDayStart(params.dateFrom) : null
  const endBoundaryExclusive = params.dateTo ? addUtcDays(params.dateTo, 1) : null
  const stalePredicates = [
    startBoundary ? `period_start < ${getSqlLiteral(startBoundary)}` : null,
    endBoundaryExclusive ? `period_end > ${getSqlLiteral(endBoundaryExclusive)}` : null,
  ].filter((part): part is string => {
    return part !== null
  })

  if (stalePredicates.length === 0) {
    return
  }

  await db.run(
    `
    DELETE FROM app.data_source_reconciliation_work
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
      AND status IN ('queued', 'running', 'failed')
      AND (${stalePredicates.join(' OR ')})
  `,
    getDataSourcesWorkloadContext({operation: 'trackingReconciliationWorkInvalidateBounds'}),
  )
}

export const deleteReconciliationWorkForStaleRoute = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; route: string | null},
) => {
  await db.run(
    `
    DELETE FROM app.data_source_reconciliation_work
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
      AND status IN ('queued', 'running', 'failed')
      AND ${params.route === null ? 'TRUE' : `(route IS NULL OR route <> ${getSqlLiteral(params.route)})`}
  `,
    getDataSourcesWorkloadContext({operation: 'trackingReconciliationWorkInvalidateRoute'}),
  )
}

export const deleteReconciliationWorkForRemovedScheduleMonths = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; scheduleMonths: number[]},
) => {
  const keptMonths = [...new Set(params.scheduleMonths)].map((month) => {
    return Math.trunc(month)
  })
  const removedMonthPredicate =
    keptMonths.length === 0 ? 'TRUE' : `(age_months IS NULL OR age_months NOT IN (${keptMonths.join(', ')}))`

  await db.run(
    `
    DELETE FROM app.data_source_reconciliation_work
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
      AND run_kind = 'automatic_age_bucket'
      AND status IN ('queued', 'running', 'failed')
      AND ${removedMonthPredicate}
  `,
    getDataSourcesWorkloadContext({operation: 'trackingReconciliationWorkInvalidateRemovedSchedule'}),
  )
}

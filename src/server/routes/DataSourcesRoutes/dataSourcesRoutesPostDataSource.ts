import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createOrUpdateTrackingStateIfEnabled} from './createOrUpdateTrackingStateIfEnabled.ts'
import {getDataSourceRow} from './getDataSourceRow.ts'
import {getDataSourcesWorkloadContext} from './getDataSourcesWorkloadContext.ts'
import {normalizeDataSourceRow} from './normalizeDataSourceRow.ts'
import {parseOptionalDate} from './parseOptionalDate.ts'
import {
  getTrackingReconcileScheduleMonthsSqlLiteral,
  normalizeTrackingReconcileScheduleMonthsForWrite,
} from './trackingReconcileScheduleMonths.ts'
import {assertTrackingCanBeEnabled} from './trackingSupportedRoutes.ts'

export const dataSourcesRoutesPostDataSource = async ({
  body,
}: {
  body: {
    title: string
    description?: string
    importRoute?: string
    dateFrom?: string
    dateTo?: string
    trackingEnabled?: boolean
    trackingReconcileScheduleMonths?: number[]
  }
}) => {
  const dateFrom = parseOptionalDate(body.dateFrom)
  const dateTo = parseOptionalDate(body.dateTo)
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error('date_from must be on or before date_to')
  }
  const trackingEnabled = body.trackingEnabled ?? false
  const importRoute = body.importRoute ?? null
  const trackingReconcileScheduleMonths = normalizeTrackingReconcileScheduleMonthsForWrite(
    body.trackingReconcileScheduleMonths,
  )
  assertTrackingCanBeEnabled({dateFrom, importRoute, trackingEnabled})

  const createdRow = await getAppDatabaseService().transaction(
    async (tx) => {
      const [created] = await tx.queryJson<{id: string; importRoute: string | null; trackingEnabled: boolean | null}>(
        `
            INSERT INTO app.data_source (
              id,
              title,
              description,
              import_route,
              date_from,
              date_to,
              tracking_enabled,
              tracking_reconcile_schedule_months
            )
            VALUES (
              '${escapeSqlString(crypto.randomUUID())}',
              ${getSqlLiteral(body.title)},
              ${getSqlLiteral(body.description ?? null)},
              ${getSqlLiteral(importRoute)},
              ${getSqlLiteral(dateFrom)},
              ${getSqlLiteral(dateTo)},
              ${trackingEnabled ? 'TRUE' : 'FALSE'},
              CAST(${getTrackingReconcileScheduleMonthsSqlLiteral(trackingReconcileScheduleMonths)} AS JSON)
            )
            RETURNING
              id,
              import_route AS importRoute,
              tracking_enabled AS trackingEnabled
          `,
        getDataSourcesWorkloadContext({maxResultRows: 1, operation: 'create'}),
      )

      if (!created) {
        return null
      }

      await createOrUpdateTrackingStateIfEnabled({
        db: tx,
        dataSourceId: created.id,
        importRoute: created.importRoute,
        trackingEnabled: created.trackingEnabled ?? false,
      })

      return getDataSourceRow(tx, created.id)
    },
    getDataSourcesWorkloadContext({operation: 'createTransaction'}),
  )

  return {
    data: createdRow
      ? normalizeDataSourceRow(createdRow, {
          covidencePackageConfig: null,
          immutable: false,
          linkedProjectId: null,
          linkedPromptIds: [],
          reimportable: false,
          structuredFileConfig: null,
        })
      : null,
  }
}

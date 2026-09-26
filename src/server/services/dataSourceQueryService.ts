import type {DataSourceRecord} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {escapeSqlString, getDateValue, getJsonValue, getTimestampLiteral} from './appQueryHelpers.ts'
import {
  getDataSourceImportCompletedSql,
  getDataSourceImportPageSavedSql,
  getDataSourceImportStateWorkloadContext,
} from './dataSourceImportStateRepository.ts'

type DataSourceRow = {
  id: string
  title: string
  description: string | null
  lastImportAt: unknown
  itemsAfterLastImport: number | null
  importRoute: string | null
  cursor: string | null
  dateFrom: unknown
  dateTo: unknown
  trackingEnabled: boolean | null
  trackingReconcileScheduleMonths: unknown
  archived: boolean | null
  createdAt: unknown
  updatedAt: unknown
}

const defaultTrackingReconcileScheduleMonths = [3, 12, 24, 36]

const getTrackingReconcileScheduleMonths = (value: unknown): number[] => {
  const parsed = getJsonValue(value)

  if (!Array.isArray(parsed)) {
    return defaultTrackingReconcileScheduleMonths
  }

  const months = parsed.filter((entry): entry is number => {
    return Number.isInteger(entry) && entry > 0
  })

  return months.length > 0 ? months : defaultTrackingReconcileScheduleMonths
}

const getDataSourceValue = (row: DataSourceRow): DataSourceRecord => {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    lastImportAt: getDateValue(row.lastImportAt),
    itemsAfterLastImport: row.itemsAfterLastImport ?? 0,
    importRoute: row.importRoute,
    cursor: row.cursor,
    dateFrom: getDateValue(row.dateFrom),
    dateTo: getDateValue(row.dateTo),
    trackingEnabled: row.trackingEnabled ?? false,
    trackingReconcileScheduleMonths: getTrackingReconcileScheduleMonths(row.trackingReconcileScheduleMonths),
    archived: row.archived ?? false,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
  }
}

const getDataSourceById = async (id: string): Promise<DataSourceRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<DataSourceRow>(`
    SELECT
      id,
      title,
      description,
      last_import_at AS lastImportAt,
      items_after_last_import AS itemsAfterLastImport,
      import_route AS importRoute,
      cursor,
      date_from AS dateFrom,
      date_to AS dateTo,
      tracking_enabled AS trackingEnabled,
      TO_JSON(tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.data_source
    WHERE id = '${escapeSqlString(id)}'
    LIMIT 1
  `)

  return row ? getDataSourceValue(row) : null
}

const countArticlesLinkedToImportRoute = async (params: {
  route: string
  dateFrom: Date | null
  dateTo: Date | null
}) => {
  const whereParts = [
    `EXISTS (
      SELECT 1
      FROM app.article_import_route air
      INNER JOIN app.import_route ir ON ir.id = air.import_route_id
      WHERE air.article_id = a.id
        AND ir.route = '${escapeSqlString(params.route)}'
    )`,
    params.dateFrom ? `a.article_created_at >= ${getTimestampLiteral(params.dateFrom)}` : null,
    params.dateTo ? `a.article_created_at <= ${getTimestampLiteral(params.dateTo)}` : null,
  ].filter((part): part is string => {
    return part !== null
  })
  const [row] = await getAppDatabaseService().queryJson<{value: number}>(`
    SELECT COUNT(*) AS value
    FROM app.article a
    WHERE ${whereParts.join(' AND ')}
  `)

  return Number(row?.value ?? 0)
}

export const updateDataSourceCursor = async (id: string, cursor: string | null) => {
  const updatedAt = new Date()

  await getAppDatabaseService().transaction(async (tx) => {
    const [row] = await tx.queryJson<{id: string}>(`
      UPDATE app.data_source
      SET cursor = ${cursor === null ? 'cursor' : `'${escapeSqlString(cursor)}'`},
          updated_at = ${getTimestampLiteral(updatedAt)}
      WHERE id = '${escapeSqlString(id)}'
      RETURNING id
    `)

    if (!row) {
      throw new Error('Data source not found')
    }

    await tx.run(getDataSourceImportPageSavedSql({dataSourceId: id, now: updatedAt}))
  }, getDataSourceImportStateWorkloadContext('saveCursor'))
}

const updateDataSourceAfterImport = async (params: {
  id: string
  importedCount: number
  importRoute?: string
  cursor?: string | null
}) => {
  const updatedAt = new Date()
  const setParts = [
    `last_import_at = ${getTimestampLiteral(updatedAt)}`,
    `items_after_last_import = ${params.importedCount}`,
    `updated_at = ${getTimestampLiteral(updatedAt)}`,
    Object.hasOwn(params, 'importRoute')
      ? `import_route = ${params.importRoute ? `'${escapeSqlString(params.importRoute)}'` : 'NULL'}`
      : null,
    Object.hasOwn(params, 'cursor')
      ? `cursor = ${params.cursor ? `'${escapeSqlString(params.cursor)}'` : 'NULL'}`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })
  const clearsImportCursor = Object.hasOwn(params, 'cursor') && !params.cursor
  const row = await getAppDatabaseService().transaction(async (tx) => {
    const [updatedRow] = await tx.queryJson<DataSourceRow>(`
      UPDATE app.data_source
      SET ${setParts.join(', ')}
      WHERE id = '${escapeSqlString(params.id)}'
      RETURNING
        id,
        title,
        description,
        last_import_at AS lastImportAt,
        items_after_last_import AS itemsAfterLastImport,
        import_route AS importRoute,
        cursor,
        date_from AS dateFrom,
        date_to AS dateTo,
        tracking_enabled AS trackingEnabled,
        TO_JSON(tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
        archived,
        created_at AS createdAt,
        updated_at AS updatedAt
    `)

    if (updatedRow && clearsImportCursor) {
      await tx.run(getDataSourceImportCompletedSql({dataSourceId: params.id, now: updatedAt}))
    }

    return updatedRow
  }, getDataSourceImportStateWorkloadContext('completeImport'))

  if (!row) {
    throw new Error('Data source not found')
  }

  return getDataSourceValue(row)
}

export const createDataSourceCursorUpdater = (id: string) => {
  return async (cursor: string | null) => {
    await updateDataSourceCursor(id, cursor)
  }
}

export const dataSourceQueryService = {
  countArticlesLinkedToImportRoute,
  createDataSourceCursorUpdater,
  getDataSourceById,
  updateDataSourceAfterImport,
  updateDataSourceCursor,
}

export const getDataSourceQueryService = () => {
  return dataSourceQueryService
}

import type {AppQueryRunner, DataSourceRow} from './dataSourcesRoutesTypes.ts'
import {normalizeDataSourceRow} from './normalizeDataSourceRow.ts'
import {getCovidenceProjectIdByImportRoute} from './normalizeDataSourceRows/getCovidenceProjectIdByImportRoute.ts'
import {getCovidencePromptIdsByImportRoute} from './normalizeDataSourceRows/getCovidencePromptIdsByImportRoute.ts'
import {getDataSourceImportState} from './normalizeDataSourceRows/getDataSourceImportState.ts'
import {getSafeCovidencePackageConfig} from './safeDataSourceImportConfigs.ts'

export const normalizeDataSourceRows = async <TRow extends DataSourceRow>(db: AppQueryRunner, rows: TRow[]) => {
  const covidenceImportRoutes = rows.flatMap((row) => {
    return row.importRoute && getSafeCovidencePackageConfig(row.cursor) ? [row.importRoute] : []
  })
  const [covidenceProjectIdByImportRoute, covidencePromptIdsByImportRoute] = await Promise.all([
    getCovidenceProjectIdByImportRoute(db, covidenceImportRoutes),
    getCovidencePromptIdsByImportRoute(db, covidenceImportRoutes),
  ])

  return rows.map((row) => {
    return normalizeDataSourceRow(
      row,
      getDataSourceImportState({
        covidenceProjectIdByImportRoute,
        covidencePromptIdsByImportRoute,
        cursor: row.cursor,
        importRoute: row.importRoute,
      }),
    )
  })
}

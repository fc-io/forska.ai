import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {AppQueryRunner} from '../dataSourcesRoutesTypes.ts'
import {getDataSourcesWorkloadContext} from '../getDataSourcesWorkloadContext.ts'

type CovidenceProjectLinkRow = {importRoute: string; projectId: string}

export const getCovidenceProjectIdByImportRoute = async (db: AppQueryRunner, importRoutes: string[]) => {
  const rows =
    importRoutes.length === 0
      ? []
      : await db.queryJson<CovidenceProjectLinkRow>(
          `
        SELECT DISTINCT ON (ir.route)
          ir.route AS importRoute,
          pir.project_id AS projectId
        FROM app.project_import_route pir
        INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
        WHERE ir.route IN (${importRoutes
          .map((importRoute) => {
            return getSqlLiteral(importRoute)
          })
          .join(', ')})
        ORDER BY ir.route ASC, pir.project_id ASC
      `,
          getDataSourcesWorkloadContext({maxResultRows: importRoutes.length, operation: 'covidenceProjectLinks'}),
        )

  return new Map(
    rows.map((row) => {
      return [row.importRoute, row.projectId]
    }),
  )
}

import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {AppQueryRunner} from '../dataSourcesRoutesTypes.ts'
import {getDataSourcesWorkloadContext} from '../getDataSourcesWorkloadContext.ts'

type CovidencePromptLinkRow = {importRoute: string; promptId: string}

const covidencePromptLinksPerImportRouteLimit = 100

export const getCovidencePromptIdsByImportRoute = async (db: AppQueryRunner, importRoutes: string[]) => {
  const rows =
    importRoutes.length === 0
      ? []
      : await db.queryJson<CovidencePromptLinkRow>(
          `
        WITH selected_import_route AS (
          SELECT id, route
          FROM app.import_route
          WHERE route IN (${importRoutes
            .map((importRoute) => {
              return getSqlLiteral(importRoute)
            })
            .join(', ')})
        )
        SELECT
          selected_import_route.route AS importRoute,
          route_prompt.promptId
        FROM selected_import_route
        INNER JOIN LATERAL (
          SELECT
            pp.prompt_id AS promptId,
            pp.prompt_order AS promptOrder
          FROM app.project_import_route pir
          INNER JOIN app.project_prompt pp ON pp.project_id = pir.project_id
          WHERE pir.import_route_id = selected_import_route.id
            AND pp.archived = FALSE
            AND pp.enabled = TRUE
          ORDER BY pp.prompt_order ASC, pp.prompt_id ASC
          LIMIT ${covidencePromptLinksPerImportRouteLimit}
        ) route_prompt ON TRUE
        ORDER BY selected_import_route.route ASC, route_prompt.promptOrder ASC, route_prompt.promptId ASC
      `,
          getDataSourcesWorkloadContext({
            maxResultRows: importRoutes.length * covidencePromptLinksPerImportRouteLimit,
            operation: 'covidencePromptLinks',
          }),
        )

  return rows.reduce<Map<string, string[]>>((promptIdsByImportRoute, row) => {
    const existingPromptIds = promptIdsByImportRoute.get(row.importRoute) ?? []

    promptIdsByImportRoute.set(row.importRoute, [...existingPromptIds, row.promptId])

    return promptIdsByImportRoute
  }, new Map())
}

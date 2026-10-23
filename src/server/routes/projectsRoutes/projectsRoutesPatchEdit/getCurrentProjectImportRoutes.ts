import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'

export const getCurrentProjectImportRoutes = async (projectId: string) => {
  const rows = await getAppDatabaseService().queryJson<{route: string}>(`
    SELECT ir.route AS route
    FROM app.project_import_route pir
    INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
    WHERE pir.project_id = '${escapeSqlString(projectId)}'
  `)

  return rows.map((row) => {
    return row.route
  })
}

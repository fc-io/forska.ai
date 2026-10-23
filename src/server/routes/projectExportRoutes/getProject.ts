import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectExportWorkloadContext} from './getProjectExportWorkloadContext.ts'

export const getProject = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<{id: string; name: string}>(
    `
    SELECT id, name
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `,
    getProjectExportWorkloadContext({maxResultRows: 1, operation: 'projectLookup', projectId}),
  )

  return project ?? null
}

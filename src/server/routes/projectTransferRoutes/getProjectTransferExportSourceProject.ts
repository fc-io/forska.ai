import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {projectTransferRouteLookupWorkloadContext} from '../../services/projectTransfer/projectTransferWorkloadContext.ts'

type ProjectTransferSourceProjectRow = {deletePendingAt: unknown; id: string}

export const getProjectTransferExportSourceProject = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<ProjectTransferSourceProjectRow>(
    `
    SELECT id, delete_pending_at AS deletePendingAt
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `,
    projectTransferRouteLookupWorkloadContext,
  )

  return project ?? null
}

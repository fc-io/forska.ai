import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {getProjectTransferExportSourceProject} from './getProjectTransferExportSourceProject.ts'
import type {RouteSet} from './projectTransferRouteTypes.ts'

export const getExportSourceProjectError = async (
  set: RouteSet,
  projectId: string,
  getExportSourceProject = getProjectTransferExportSourceProject,
): Promise<ProjectTransferApiResponse<unknown> | null> => {
  const project = await getExportSourceProject(projectId)

  if (project === null) {
    return getProjectTransferApiError(set, 404, 'Project not found')
  }

  if (project.deletePendingAt !== null && project.deletePendingAt !== undefined) {
    return getProjectTransferApiError(set, 409, 'Project is pending permanent deletion')
  }

  return null
}

import type {ProjectTransferRawArticleProvenanceMode} from '../../services/projectTransfer/projectTransferContracts.ts'
import {
  getProjectTransferExportSummary,
  type ProjectTransferExportSummary,
} from '../../services/projectTransfer/projectTransferExport.ts'
import {getExportSourceProjectError} from './getExportSourceProjectError.ts'
import type {ProjectTransferRoutesDependencies, RouteSet} from './projectTransferRouteTypes.ts'

type ProjectTransferExportSummaryResponse = ProjectTransferExportSummary & {
  defaultRawArticleProvenanceMode: ProjectTransferRawArticleProvenanceMode
}

export const projectTransferRoutesGetExportProject = async ({
  dependencies,
  params,
  set,
}: {
  dependencies: ProjectTransferRoutesDependencies
  params: {id: string}
  set: RouteSet
}) => {
  const sourceProjectError = await getExportSourceProjectError(set, params.id, dependencies.getExportSourceProject)

  if (sourceProjectError !== null) {
    return sourceProjectError
  }

  const summary = await getProjectTransferExportSummary(params.id)

  return {
    data: {...summary, defaultRawArticleProvenanceMode: 'omit' as const} satisfies ProjectTransferExportSummaryResponse,
    error: null,
  }
}

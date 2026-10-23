import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {getProjectTransferExportTempLayout} from '../../services/projectTransfer/projectTransferSession.ts'
import {getExportSessionResponse} from './getExportSessionResponse.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {getProjectTransferPackageHeaders} from './getProjectTransferPackageHeaders.ts'
import type {RouteSet} from './projectTransferRouteTypes.ts'

export const getDownloadResponse = async (set: RouteSet, exportId: string) => {
  const sessionResponse = await getExportSessionResponse(set, exportId)

  if (sessionResponse.error !== null) {
    return sessionResponse
  }

  if (sessionResponse.data.status !== 'ready') {
    return sessionResponse
  }

  const packagePath = resolveProjectTransferTempWritablePath({
    pathValue: getProjectTransferExportTempLayout(exportId).packagePath,
  })
  const file = globalThis.Bun.file(packagePath)
  const exists = await file.exists()

  return exists
    ? new Response(file, {headers: getProjectTransferPackageHeaders(sessionResponse.data)})
    : getProjectTransferApiError(set, 410, 'Project transfer export package artifact is unavailable')
}

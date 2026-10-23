import type {
  ProjectTransferApiResponse,
  ProjectTransferExportReadyPayload,
  ProjectTransferProgressPayload,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {
  getProjectTransferExportTempLayout,
  isProjectTransferSessionId,
} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import type {
  ProjectTransferExportNonReadyStatus,
  ProjectTransferExportSessionData,
  RouteSet,
} from './projectTransferRouteTypes.ts'
import {readProjectTransferArtifactJson} from './readProjectTransferArtifactJson.ts'

const getExportPendingStatusFromProgress = (
  progress: ProjectTransferProgressPayload,
): ProjectTransferExportNonReadyStatus => {
  return progress.phase === 'export_package_write' ? 'packaging' : 'assembling'
}

export const getExportSessionArtifactResponse = async (
  set: RouteSet,
  exportId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferExportSessionData> | null> => {
  if (!isProjectTransferSessionId(exportId)) {
    return null
  }

  const layout = getProjectTransferExportTempLayout(exportId)
  const [completion, progress] = await Promise.all([
    readProjectTransferArtifactJson<ProjectTransferExportReadyPayload>(layout.completionPath),
    readProjectTransferArtifactJson<ProjectTransferProgressPayload>(layout.progressPath),
  ])
  const expiresAt = typeof completion?.expiresAt === 'string' ? completion.expiresAt : progress?.expiresAt

  if (typeof expiresAt !== 'string') {
    return null
  }

  if (new Date(expiresAt).getTime() <= Date.now()) {
    return getProjectTransferApiError(set, 410, 'Project transfer export session expired')
  }

  if (completion?.status === 'ready') {
    return {
      data: {
        byteLength: completion.byteLength,
        checksumSha256: completion.checksumSha256,
        downloadUrl: completion.downloadUrl,
        expiresAt: completion.expiresAt,
        exportId,
        filename: completion.filename,
        packageFingerprint: completion.packageFingerprint,
        progress,
        status: 'ready',
      },
      error: null,
    }
  }

  if (progress === null) {
    return null
  }

  if (progress.status === 'failed') {
    return getProjectTransferApiError(set, 409, 'Project transfer export failed')
  }

  return {data: {exportId, expiresAt, progress, status: getExportPendingStatusFromProgress(progress)}, error: null}
}

import type {
  ProjectTransferApiResponse,
  ProjectTransferImportCompletionPayload,
  ProjectTransferProgressPayload,
  ProjectTransferSessionResponse,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {
  getProjectTransferImportTempLayout,
  isProjectTransferSessionId,
} from '../../services/projectTransfer/projectTransferSession.ts'
import {getDefaultImportSessionExpiresAt} from './getDefaultImportSessionExpiresAt.ts'
import {getImportSessionData} from './getImportSessionData.ts'
import type {ProjectTransferImportSessionData} from './projectTransferRouteTypes.ts'
import {readProjectTransferArtifactJson} from './readProjectTransferArtifactJson.ts'

const getImportSessionStateFromProgress = (
  progress: ProjectTransferProgressPayload,
): ProjectTransferSessionResponse['state'] | null => {
  if (progress.status === 'failed') {
    return 'failed'
  }

  if (progress.status !== 'running') {
    return null
  }

  return progress.overall?.operation === 'commit'
    || progress.phase === 'commit'
    || progress.phase === 'revalidation'
    || progress.phase === 'app_table_writes'
    || progress.phase === 'asset_promotion'
    || progress.phase === 'history_write'
    ? 'committing'
    : progress.phase === 'extract' || progress.phase === 'package_scan' || progress.phase === 'staging_load'
      ? 'extracting'
      : 'analyzing'
}

export const getImportSessionArtifactResponse = async (
  exportId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData> | null> => {
  if (!isProjectTransferSessionId(exportId)) {
    return null
  }

  const layout = getProjectTransferImportTempLayout(exportId)
  const [completion, progress] = await Promise.all([
    readProjectTransferArtifactJson<ProjectTransferImportCompletionPayload>(layout.completionPath),
    readProjectTransferArtifactJson<ProjectTransferProgressPayload>(layout.progressPath),
  ])

  if (completion?.status === 'completed') {
    const completedAt = typeof progress?.updatedAt === 'string' ? new Date(progress.updatedAt) : new Date()
    const response: ProjectTransferSessionResponse = {
      commitId: null,
      completion,
      createdAt: completedAt,
      direction: 'import',
      error: null,
      expiresAt: getDefaultImportSessionExpiresAt(completedAt),
      heartbeatAt: null,
      id: exportId,
      ownerToken: null,
      packageFingerprint: completion.packageFingerprint ?? null,
      planRevision: typeof progress?.planRevision === 'number' ? progress.planRevision : 0,
      planSummary: null,
      progress: progress ?? null,
      state: 'completed',
      updatedAt: completedAt,
    }

    return {data: getImportSessionData(response, null, 'background'), error: null}
  }

  if (progress === null) {
    return null
  }

  const state = getImportSessionStateFromProgress(progress)

  if (state === null) {
    return null
  }

  const expiresAt =
    typeof progress.expiresAt === 'string' ? new Date(progress.expiresAt) : getDefaultImportSessionExpiresAt(new Date())
  const updatedAt = typeof progress.updatedAt === 'string' ? new Date(progress.updatedAt) : new Date()
  const response: ProjectTransferSessionResponse = {
    commitId: null,
    completion: null,
    createdAt: updatedAt,
    direction: 'import',
    error: null,
    expiresAt,
    heartbeatAt: null,
    id: exportId,
    ownerToken: null,
    packageFingerprint: null,
    planRevision: typeof progress.planRevision === 'number' ? progress.planRevision : 0,
    planSummary: null,
    progress,
    state,
    updatedAt,
  }

  return {data: getImportSessionData(response, null, 'background'), error: null}
}

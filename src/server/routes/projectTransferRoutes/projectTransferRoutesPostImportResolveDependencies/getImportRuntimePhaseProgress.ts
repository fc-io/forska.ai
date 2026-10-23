import type {ProjectTransferProgressPayload} from '../../../services/projectTransfer/projectTransferContracts.ts'
import type {ProjectTransferPerformanceMetrics} from '../../../services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {getProjectTransferProgressStagingRevision} from '../../../services/projectTransfer/projectTransferStaging.ts'
import {getUploadMetadataFromProgress} from '../getUploadMetadataFromProgress.ts'

export const getImportRuntimePhaseProgress = ({
  message,
  now,
  overall,
  performanceMetrics,
  phase,
  previousProgress,
  status,
  warningCount,
}: {
  message?: string | null
  now: Date
  overall?: ProjectTransferProgressPayload['overall']
  performanceMetrics?: ProjectTransferPerformanceMetrics
  phase: ProjectTransferProgressPayload['phase']
  previousProgress: ProjectTransferProgressPayload | null
  status: ProjectTransferProgressPayload['status']
  warningCount?: number | null
}): ProjectTransferProgressPayload => {
  const stagingRevision = getProjectTransferProgressStagingRevision(previousProgress)

  return {
    ...(message === undefined ? {} : {message}),
    ...(overall === null || overall === undefined ? {} : {overall}),
    performanceMetrics: performanceMetrics ?? previousProgress?.performanceMetrics,
    phase,
    planRevision: previousProgress?.planRevision ?? null,
    ...(previousProgress?.staging === undefined ? {} : {staging: previousProgress.staging}),
    ...(stagingRevision === null ? {} : {stagingRevision}),
    status,
    updatedAt: now.toISOString(),
    uploadMetadata: getUploadMetadataFromProgress(previousProgress),
    warningCount: warningCount ?? previousProgress?.warningCount ?? null,
  }
}

import type {
  ProjectTransferProgressPayload,
  ProjectTransferUploadMetadataPayload,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import type {ProjectTransferPerformanceMetrics} from '../../services/projectTransfer/projectTransferPerformanceMetrics.ts'

export const getAnalyzeProgress = ({
  now,
  overall,
  performanceMetrics,
  phase,
  status,
  upload,
}: {
  now: Date
  overall?: ProjectTransferProgressPayload['overall']
  performanceMetrics?: ProjectTransferPerformanceMetrics
  phase: 'analyze' | 'extract' | 'package_scan'
  status: ProjectTransferProgressPayload['status']
  upload: ProjectTransferUploadMetadataPayload | null
}): ProjectTransferProgressPayload => {
  const byteLength = upload?.byteLength ?? null
  const isPackageScan = phase === 'package_scan' && byteLength !== null

  return {
    ...(isPackageScan ? {bytesProcessed: status === 'completed' ? byteLength : 0, bytesTotal: byteLength} : {}),
    ...(isPackageScan ? {completedBytes: status === 'completed' ? byteLength : 0, totalBytes: byteLength} : {}),
    ...(overall === null || overall === undefined ? {} : {overall}),
    phase,
    performanceMetrics,
    ...(isPackageScan && status === 'completed' ? {percent: 100} : {}),
    status,
    updatedAt: now.toISOString(),
    uploadMetadata: upload,
  }
}

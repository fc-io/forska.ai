import {randomUUID} from 'node:crypto'

import type {
  ProjectTransferApiResponse,
  ProjectTransferProgressPayload,
  ProjectTransferUploadMetadataPayload,
} from '../../services/projectTransfer/projectTransferContracts.ts'
import {runWithDuckdbExclusiveWork} from '../../services/projectTransfer/projectTransferDuckdbExclusiveWork.ts'
import {resolveProjectTransferTempWritablePath} from '../../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferPerformanceMetrics,
  measureProjectTransferPhase,
  projectTransferMetricUnavailable,
  type ProjectTransferPerformanceMetrics,
} from '../../services/projectTransfer/projectTransferPerformanceMetrics.ts'
import {getProjectTransferOverallProgress} from '../../services/projectTransfer/projectTransferProgressWeights.ts'
import {getProjectTransferImportTempLayout} from '../../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../../services/projectTransfer/projectTransferSessionRepository.ts'
import {getErrorPayload} from './getErrorPayload.ts'
import {getImportSessionResponseFromRecord} from './getImportSessionResponseFromRecord.ts'
import {getProjectTransferApiError} from './getProjectTransferApiError.ts'
import {writeImportUploadArtifact} from './projectTransferRoutesPutImportUpload/writeImportUploadArtifact.ts'
import type {ProjectTransferImportSessionData, RouteSet} from './projectTransferRouteTypes.ts'
import {runProjectTransferImportWorkerHeartbeat} from './runProjectTransferImportWorkerHeartbeat.ts'

const getUploadFileName = (request: Request) => {
  const headerFileName = request.headers.get('x-project-transfer-filename')?.trim()

  return headerFileName && headerFileName.length > 0 ? headerFileName : 'upload.zip'
}

const isUploadResourceGateError = (error: unknown) => {
  return error instanceof Error && error.name === 'ProjectTransferUploadResourceGateError'
}

const isUploadContentLengthMismatchError = (error: unknown) => {
  return error instanceof Error && error.name === 'ProjectTransferUploadContentLengthMismatchError'
}

const getUploadProgress = ({
  metadata,
  now,
  performanceMetrics,
  status,
}: {
  metadata?: ProjectTransferUploadMetadataPayload | null
  now: Date
  performanceMetrics?: ProjectTransferPerformanceMetrics
  status: ProjectTransferProgressPayload['status']
}): ProjectTransferProgressPayload => {
  const byteLength = metadata?.byteLength ?? 0

  return {
    bytesProcessed: byteLength,
    bytesTotal: byteLength,
    completedBytes: byteLength,
    ...(status === 'completed'
      ? {overall: getProjectTransferOverallProgress({operation: 'analyze', step: 'upload', stepFraction: 1})}
      : {}),
    phase: 'upload',
    performanceMetrics,
    status,
    totalBytes: byteLength,
    updatedAt: now.toISOString(),
    uploadMetadata: metadata ?? null,
  }
}

const getUploadWriteAttempt = async (params: {fileName: string; request: Request; sessionId: string}) => {
  try {
    return await writeImportUploadArtifact(params)
  } catch (error) {
    return {error, ok: false as const}
  }
}

export const uploadImportPackage = async ({
  params,
  request,
  set,
}: {
  params: {sessionId: string}
  request: Request
  set: RouteSet
}): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  if (request.body === null) {
    return getProjectTransferApiError(set, 400, 'Project transfer upload requires a request body')
  }

  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId: params.sessionId})
  const currentResponse = await getImportSessionResponseFromRecord(set, current)

  if (currentResponse === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer import session not found')
  }

  if (currentResponse.error !== null) {
    return currentResponse
  }

  if (currentResponse.data.state !== 'awaiting_upload') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session is not awaiting upload')
  }

  const layout = getProjectTransferImportTempLayout(params.sessionId)
  const uploadPath = resolveProjectTransferTempWritablePath({pathValue: layout.uploadPath})
  const uploadExists = await globalThis.Bun.file(uploadPath).exists()

  if (uploadExists) {
    return getProjectTransferApiError(set, 409, 'Project transfer import session already has an upload')
  }

  const ownerToken = randomUUID()
  const uploadStartedAt = new Date()
  const claimed = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: null,
    expectedState: 'awaiting_upload',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'uploading',
    now: uploadStartedAt,
    progress: getUploadProgress({metadata: null, now: uploadStartedAt, status: 'running'}),
    sessionId: params.sessionId,
  })

  if (claimed === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import session upload could not be claimed')
  }

  const uploadMeasurement = await measureProjectTransferPhase('upload', () => {
    return runProjectTransferImportWorkerHeartbeat({
      operation: () => {
        return runWithDuckdbExclusiveWork(
          {
            estimatedRows: null,
            kind: 'project_transfer_import',
            message: 'Package upload running',
            ownerToken,
            phase: 'upload',
            sessionId: params.sessionId,
          },
          () => {
            return getUploadWriteAttempt({fileName: getUploadFileName(request), request, sessionId: params.sessionId})
          },
        )
      },
      ownerToken,
      sessionId: params.sessionId,
    })
  })
  const upload = uploadMeasurement.value
  const uploadPerformanceMetrics = getProjectTransferPerformanceMetrics({
    benchmark: {wallTimeMs: uploadMeasurement.timing.durationMs},
    bytes: {uploadPackageBytes: upload.ok ? upload.metadata.byteLength : projectTransferMetricUnavailable},
    operation: 'import',
    phases: {upload: uploadMeasurement.timing},
  })

  if (!upload.ok) {
    const uploadErrorMessage = isUploadResourceGateError(upload.error)
      ? (upload.error as Error).message
      : isUploadContentLengthMismatchError(upload.error)
        ? (upload.error as Error).message
        : 'Project transfer upload failed'

    await repository.transitionProjectTransferSessionState({
      error: getErrorPayload(upload.error),
      expectedOwnerToken: ownerToken,
      expectedState: 'uploading',
      nextOwnerToken: null,
      nextState: 'failed',
      progress: getUploadProgress({
        metadata: null,
        now: new Date(),
        performanceMetrics: uploadPerformanceMetrics,
        status: 'failed',
      }),
      sessionId: params.sessionId,
    })

    return getProjectTransferApiError(
      set,
      isUploadResourceGateError(upload.error) ? 413 : isUploadContentLengthMismatchError(upload.error) ? 400 : 500,
      uploadErrorMessage,
    )
  }

  const completedAt = new Date()
  const queued = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'uploading',
    nextOwnerToken: null,
    nextState: 'queued',
    now: completedAt,
    progress: getUploadProgress({
      metadata: upload.metadata,
      now: completedAt,
      performanceMetrics: uploadPerformanceMetrics,
      status: 'completed',
    }),
    sessionId: params.sessionId,
  })

  return queued === null
    ? getProjectTransferApiError(set, 409, 'Project transfer import session upload ownership was lost')
    : ((await getImportSessionResponseFromRecord(set, queued))
        ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
}

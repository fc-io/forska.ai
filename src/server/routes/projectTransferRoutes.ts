import {createHash, randomUUID} from 'node:crypto'
import {createWriteStream, type WriteStream} from 'node:fs'
import {mkdir, rename, rm} from 'node:fs/promises'
import {dirname} from 'node:path'

import {type as arktype} from 'arktype'
import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {analyzeProjectTransferImportPackage} from '../services/projectTransfer/projectTransferAnalyze.ts'
import {
  getProjectTransferImportAnalyzeExecutionMode,
  getProjectTransferPlaceholderResponse,
  type ProjectTransferApiResponse,
  type ProjectTransferCancellationReason,
  type ProjectTransferExecutionMode,
  type ProjectTransferExportReadyPayload,
  type ProjectTransferPlanSummary,
  type ProjectTransferProgressPayload,
  type ProjectTransferSessionResponse,
  type ProjectTransferUploadMetadataPayload,
  type ProjectTransferUploadSession,
  validateProjectTransferPlanReadyToCommit,
} from '../services/projectTransfer/projectTransferContracts.ts'
import {
  createProjectTransferExport,
  type ProjectTransferExportPackageMetadata,
} from '../services/projectTransfer/projectTransferExportPackage.ts'
import {resolveProjectTransferTempWritablePath} from '../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferExportTempLayout,
  getProjectTransferImportTempLayout,
  isProjectTransferSessionId,
  toProjectTransferSessionResponse,
} from '../services/projectTransfer/projectTransferSession.ts'
import {getProjectTransferSessionRepository} from '../services/projectTransfer/projectTransferSessionRepository.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type ProjectTransferExportResponse = {
  downloadUrl: string
  expiresAt: string
  exportId: string
  filename: string
  status: 'queued'
}
type ProjectTransferExportNonReadyStatus = 'assembling' | 'packaging' | 'queued'
type ProjectTransferExportSessionPendingResponse = {
  exportId: string
  expiresAt: string
  progress: ProjectTransferProgressPayload | null
  status: ProjectTransferExportNonReadyStatus
}
type ProjectTransferExportSessionReadyResponse = ProjectTransferExportPackageMetadata & {
  exportId: string
  progress: ProjectTransferProgressPayload | null
  status: 'ready'
}
type ProjectTransferExportSessionData =
  | ProjectTransferExportSessionPendingResponse
  | ProjectTransferExportSessionReadyResponse
type ProjectTransferImportSessionData = ProjectTransferSessionResponse & {
  analyzeUrl: string
  blockers: string[]
  canCommit: boolean
  cancelUrl: string
  commitUrl: string
  duplicatePackageWarnings: string[]
  executionMode?: ProjectTransferExecutionMode
  overlapCounts: ProjectTransferPlanSummary['overlapCounts'] | null
  resolveDependenciesUrl: string
  sessionUrl: string
  upload: ProjectTransferUploadMetadataPayload | null
  uploadUrl: string
  warnings: string[]
}
type ProjectTransferPlaceholderData =
  | ProjectTransferExportResponse
  | ProjectTransferExportSessionData
  | ProjectTransferImportSessionData
  | ProjectTransferSessionResponse
  | ProjectTransferUploadSession
type ProjectTransferSourceProjectRow = {deletePendingAt: unknown; id: string}
type RouteSet = {status?: number | string}
type ProjectTransferPackageHeaderMetadata = Pick<
  ProjectTransferExportReadyPayload,
  'byteLength' | 'checksumSha256' | 'expiresAt' | 'filename' | 'packageFingerprint'
>

export const projectTransferRouteSpecs = [
  {
    endpoint: 'export-project',
    method: 'POST',
    path: '/api/projects/:id/export-project',
    samplePath: '/api/projects/project-1/export-project',
  },
  {
    endpoint: 'get-export',
    method: 'GET',
    path: '/api/projects/export/:exportId',
    samplePath: '/api/projects/export/export-1',
  },
  {
    endpoint: 'download-export',
    method: 'GET',
    path: '/api/projects/export/:exportId/download',
    samplePath: '/api/projects/export/export-1/download',
  },
  {
    endpoint: 'create-import-session',
    method: 'POST',
    path: '/api/projects/import/sessions',
    samplePath: '/api/projects/import/sessions',
  },
  {
    endpoint: 'upload-import-package',
    method: 'PUT',
    path: '/api/projects/import/:sessionId/upload',
    samplePath: '/api/projects/import/session-1/upload',
  },
  {
    endpoint: 'analyze-import-session',
    method: 'POST',
    path: '/api/projects/import/:sessionId/analyze',
    samplePath: '/api/projects/import/session-1/analyze',
  },
  {
    endpoint: 'get-import-session',
    method: 'GET',
    path: '/api/projects/import/:sessionId',
    samplePath: '/api/projects/import/session-1',
  },
  {
    endpoint: 'resolve-import-dependencies',
    method: 'POST',
    path: '/api/projects/import/:sessionId/resolve-dependencies',
    samplePath: '/api/projects/import/session-1/resolve-dependencies',
  },
  {
    endpoint: 'commit-import-session',
    method: 'POST',
    path: '/api/projects/import/:sessionId/commit',
    samplePath: '/api/projects/import/session-1/commit',
  },
  {
    endpoint: 'delete-import-session',
    method: 'DELETE',
    path: '/api/projects/import/:sessionId',
    samplePath: '/api/projects/import/session-1',
  },
] as const

const routeParamSchema = t.Object({id: t.String({minLength: 1})})
const exportParamSchema = t.Object({exportId: t.String({minLength: 1})})
const importSessionParamSchema = t.Object({sessionId: t.String({minLength: 1})})
const exportProjectBodySchema = t.Optional(t.Object({}, {additionalProperties: true}))
const createImportSessionRequestShape = arktype({
  'expiresAt?': 'string',
  'packageFingerprint?': 'string | null',
  'sessionId?': 'string',
})
const analyzeImportSessionRequestShape = arktype({
  'expectedPlanRevision?': 'number.integer >= 0',
  'expandedBytes?': 'number.integer >= 0',
  'zipBytes?': 'number.integer >= 0',
})
const resolveImportDependenciesRequestShape = arktype({
  'expectedPlanRevision?': 'number.integer >= 0',
  'resolutions?': 'unknown',
})
const commitImportSessionRequestShape = arktype({
  'expectedOwnerToken?': 'string',
  'expectedPlanRevision?': 'number.integer >= 0',
})
const cancelImportSessionRequestShape = arktype({
  'cleanupTempArtifacts?': 'boolean',
  'expectedOwnerToken?': 'string',
  'reason?': arktype('"cleanup_failed" | "session_expired" | "user_cancelled"'),
})
type CreateImportSessionRequest = typeof createImportSessionRequestShape.infer
type AnalyzeImportSessionRequest = typeof analyzeImportSessionRequestShape.infer
type ResolveImportDependenciesRequest = typeof resolveImportDependenciesRequestShape.infer
type CommitImportSessionRequest = typeof commitImportSessionRequestShape.infer
type CancelImportSessionRequest = typeof cancelImportSessionRequestShape.infer

const getPlaceholderResponse = (
  set: RouteSet,
  endpoint: (typeof projectTransferRouteSpecs)[number]['endpoint'],
): ProjectTransferApiResponse<ProjectTransferPlaceholderData> => {
  set.status = 501
  return getProjectTransferPlaceholderResponse<ProjectTransferPlaceholderData>(endpoint)
}

const getProjectTransferExportSourceProject = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<ProjectTransferSourceProjectRow>(`
    SELECT id, delete_pending_at AS deletePendingAt
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return project ?? null
}

const getProjectTransferApiError = <TData>(
  set: RouteSet,
  status: number,
  error: string,
): ProjectTransferApiResponse<TData> => {
  set.status = status
  return {data: null, error}
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getUnexpectedBodyKey = (value: Record<string, unknown>, allowedKeys: readonly string[]) => {
  return Object.keys(value).find((key) => {
    return !allowedKeys.includes(key)
  })
}

const parseRequestBody = <TValue>(
  body: unknown,
  shape: (value: unknown) => unknown,
  allowedKeys: readonly string[],
): {error: string; ok: false} | {ok: true; value: TValue} => {
  const normalizedBody = body ?? {}

  if (!isRecord(normalizedBody)) {
    return {error: 'Project transfer request body must be an object', ok: false}
  }

  const unexpectedKey = getUnexpectedBodyKey(normalizedBody, allowedKeys)

  if (unexpectedKey) {
    return {error: `Project transfer request body contains unsupported field ${unexpectedKey}`, ok: false}
  }

  const parsed = shape(normalizedBody)

  return Array.isArray(parsed)
    ? {error: `Invalid project transfer request body: ${String(parsed)}`, ok: false}
    : {ok: true, value: parsed as TValue}
}

const getImportSessionUrls = (sessionId: string) => {
  const sessionUrl = `/api/projects/import/${sessionId}`

  return {
    analyzeUrl: `${sessionUrl}/analyze`,
    cancelUrl: sessionUrl,
    commitUrl: `${sessionUrl}/commit`,
    resolveDependenciesUrl: `${sessionUrl}/resolve-dependencies`,
    sessionUrl,
    uploadUrl: `${sessionUrl}/upload`,
  }
}

const getDefaultImportSessionExpiresAt = (now: Date) => {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000)
}

const parseImportSessionExpiresAt = (expiresAt: string | undefined, now: Date) => {
  if (expiresAt === undefined) {
    return {ok: true as const, value: getDefaultImportSessionExpiresAt(now)}
  }

  const parsed = new Date(expiresAt)

  return Number.isNaN(parsed.getTime())
    ? {error: 'Project transfer import session expiresAt must be a valid date-time', ok: false as const}
    : parsed.getTime() <= now.getTime()
      ? {error: 'Project transfer import session expiresAt must be in the future', ok: false as const}
      : {ok: true as const, value: parsed}
}

const getImportSessionId = (requestedSessionId: string | undefined) => {
  const sessionId = requestedSessionId ?? randomUUID()

  return isProjectTransferSessionId(sessionId)
    ? {ok: true as const, value: sessionId}
    : {error: 'Project transfer session id must be path-safe', ok: false as const}
}

const isUploadMetadataPayload = (value: unknown): value is ProjectTransferUploadMetadataPayload => {
  return (
    isRecord(value)
    && typeof value.byteLength === 'number'
    && Number.isInteger(value.byteLength)
    && value.byteLength >= 0
    && typeof value.checksumSha256 === 'string'
    && typeof value.fileName === 'string'
  )
}

const getUploadMetadataFromProgress = (
  progress: ProjectTransferProgressPayload | null,
): ProjectTransferUploadMetadataPayload | null => {
  return isUploadMetadataPayload(progress?.uploadMetadata) ? progress.uploadMetadata : null
}

const getImportSessionBlockers = (planSummary: ProjectTransferPlanSummary | null) => {
  return planSummary?.blockers && planSummary.blockers.length > 0
    ? planSummary.blockers.map((blocker) => {
        return blocker.message
      })
    : planSummary === null || planSummary.blockerCount === 0
      ? []
      : [`${planSummary.blockerCount} import plan blocker(s) require resolution`]
}

const getImportSessionWarnings = (planSummary: ProjectTransferPlanSummary | null) => {
  return planSummary?.packageWarnings && planSummary.packageWarnings.length > 0
    ? planSummary.packageWarnings.map((warning) => {
        return warning.message
      })
    : planSummary === null || planSummary.warningCount === 0
      ? []
      : [`${planSummary.warningCount} import plan warning(s) require review`]
}

const getImportPlanRowCount = (planSummary: ProjectTransferPlanSummary) => {
  return planSummary.packageCounts
    ? Object.values(planSummary.packageCounts).reduce((total, count) => {
        return total + count
      }, 0)
    : 0
}

const canCommitImportSession = (response: ProjectTransferSessionResponse) => {
  return response.state === 'ready_to_commit' && validateProjectTransferPlanReadyToCommit(response.planSummary).ok
}

const getImportSessionData = (
  response: ProjectTransferSessionResponse,
  executionMode?: ProjectTransferExecutionMode,
): ProjectTransferImportSessionData => {
  return {
    ...response,
    ...getImportSessionUrls(response.id),
    blockers: getImportSessionBlockers(response.planSummary),
    canCommit: canCommitImportSession(response),
    duplicatePackageWarnings: [],
    executionMode,
    overlapCounts: response.planSummary?.overlapCounts ?? null,
    upload: getUploadMetadataFromProgress(response.progress),
    warnings: getImportSessionWarnings(response.planSummary),
  }
}

const getImportSessionResponseFromRecord = (
  record: Awaited<ReturnType<ReturnType<typeof getProjectTransferSessionRepository>['getProjectTransferSession']>>,
  executionMode?: ProjectTransferExecutionMode,
): ProjectTransferApiResponse<ProjectTransferImportSessionData> | null => {
  if (record === null) {
    return null
  }

  const response = toProjectTransferSessionResponse(record)

  return response.direction === 'import'
    ? {data: getImportSessionData(response, executionMode), error: null}
    : {data: null, error: 'Project transfer session is not an import session'}
}

const getUploadFileName = (request: Request) => {
  const headerFileName = request.headers.get('x-project-transfer-filename')?.trim()

  return headerFileName && headerFileName.length > 0 ? headerFileName : 'upload.zip'
}

const getUploadTempPathValue = ({ownerToken, sessionId}: {ownerToken: string; sessionId: string}) => {
  return `${getProjectTransferImportTempLayout(sessionId).rootPath}/upload.${ownerToken}.tmp`
}

const writeFileStreamChunk = (stream: WriteStream, chunk: Uint8Array) => {
  return new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

const closeFileStream = (stream: WriteStream) => {
  return new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

const getUploadProgress = ({
  metadata,
  now,
  status,
}: {
  metadata?: ProjectTransferUploadMetadataPayload | null
  now: Date
  status: ProjectTransferProgressPayload['status']
}): ProjectTransferProgressPayload => {
  const byteLength = metadata?.byteLength ?? 0

  return {
    bytesProcessed: byteLength,
    bytesTotal: byteLength,
    completedBytes: byteLength,
    phase: 'upload',
    status,
    totalBytes: byteLength,
    updatedAt: now.toISOString(),
    uploadMetadata: metadata ?? null,
  }
}

const getAnalyzeProgress = ({
  now,
  phase,
  status,
  upload,
}: {
  now: Date
  phase: 'analyze' | 'extract'
  status: ProjectTransferProgressPayload['status']
  upload: ProjectTransferUploadMetadataPayload | null
}): ProjectTransferProgressPayload => {
  const byteLength = upload?.byteLength ?? 0

  return {
    bytesProcessed: byteLength,
    bytesTotal: byteLength,
    completedBytes: byteLength,
    phase,
    percent: status === 'completed' ? 100 : 0,
    status,
    totalBytes: byteLength,
    updatedAt: now.toISOString(),
    uploadMetadata: upload,
  }
}

const writeImportUploadArtifact = async ({
  fileName,
  request,
  sessionId,
}: {
  fileName: string
  request: Request
  sessionId: string
}) => {
  if (request.body === null) {
    return {error: 'Project transfer upload requires a request body', ok: false as const}
  }

  const layout = getProjectTransferImportTempLayout(sessionId)
  const ownerToken = randomUUID()
  const uploadPath = resolveProjectTransferTempWritablePath({pathValue: layout.uploadPath})
  const tempPath = resolveProjectTransferTempWritablePath({pathValue: getUploadTempPathValue({ownerToken, sessionId})})
  const hash = createHash('sha256')
  const state = {byteLength: 0}
  let writeSucceeded = false

  await mkdir(dirname(uploadPath), {recursive: true})

  const fileStream = createWriteStream(tempPath)
  const stream = new WritableStream<Uint8Array>({
    abort(reason) {
      fileStream.destroy(reason instanceof Error ? reason : undefined)
    },
    close() {
      return closeFileStream(fileStream)
    },
    write(chunk) {
      state.byteLength += chunk.byteLength
      hash.update(chunk)
      return writeFileStreamChunk(fileStream, chunk)
    },
  })

  try {
    await request.body.pipeTo(stream)
    await rename(tempPath, uploadPath)
    writeSucceeded = true
  } finally {
    if (!writeSucceeded) {
      await rm(tempPath, {force: true})
    }
  }

  return {metadata: {byteLength: state.byteLength, checksumSha256: hash.digest('hex'), fileName}, ok: true as const}
}

const getUploadWriteAttempt = async (params: {fileName: string; request: Request; sessionId: string}) => {
  try {
    return await writeImportUploadArtifact(params)
  } catch (error) {
    return {error, ok: false as const}
  }
}

const getErrorPayload = (error: unknown) => {
  return error instanceof Error ? {message: error.message, name: error.name} : {message: String(error)}
}

const getCompletedAnalyzeProgress = ({
  now,
  planSummary,
  upload,
}: {
  now: Date
  planSummary: ProjectTransferPlanSummary
  upload: ProjectTransferUploadMetadataPayload | null
}) => {
  const rowCount = getImportPlanRowCount(planSummary)

  return {
    ...getAnalyzeProgress({now, phase: 'analyze', status: 'completed', upload}),
    completedRows: rowCount,
    rowCountProcessed: rowCount,
    rowCountTotal: rowCount,
    totalRows: rowCount,
    warningCount: planSummary.warningCount,
  }
}

const getImportAnalyzeNextState = (planSummary: ProjectTransferPlanSummary) => {
  return planSummary.blockerCount === 0 ? 'ready_to_commit' : 'awaiting_resolution'
}

const runProjectTransferImportAnalyzeJob = async ({ownerToken, sessionId}: {ownerToken: string; sessionId: string}) => {
  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId})
  const upload =
    current === null ? null : getUploadMetadataFromProgress(toProjectTransferSessionResponse(current).progress)
  const analyzeStartedAt = new Date()
  const analyzingProgress = getAnalyzeProgress({now: analyzeStartedAt, phase: 'analyze', status: 'running', upload})
  const analyzing = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'extracting',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'analyzing',
    now: analyzeStartedAt,
    progress: analyzingProgress,
    sessionId,
  })

  if (analyzing === null) {
    return null
  }

  await repository.heartbeatProjectTransferSessionOwner({leaseMs: 60_000, ownerToken, sessionId})

  const analysis = await analyzeProjectTransferImportPackage({
    layout: getProjectTransferImportTempLayout(sessionId),
    planRevision: analyzing.planRevision + 1,
    uploadMetadata: upload,
  })
  const completedAt = new Date()
  const completedProgress = getCompletedAnalyzeProgress({now: completedAt, planSummary: analysis.planSummary, upload})
  const nextState = getImportAnalyzeNextState(analysis.planSummary)
  const planned = await repository.updateProjectTransferSessionPlanRevision({
    expectedOwnerToken: ownerToken,
    expectedPlanRevision: analyzing.planRevision,
    nextState,
    now: completedAt,
    planSummary: analysis.planSummary,
    sessionId,
  })

  return planned === null
    ? null
    : repository.transitionProjectTransferSessionState({
        expectedOwnerToken: ownerToken,
        expectedState: nextState,
        nextOwnerToken: null,
        nextState,
        now: completedAt,
        packageFingerprint: analysis.packageFingerprint,
        progress: completedProgress,
        sessionId,
      })
}

const failProjectTransferImportAnalyzeSession = async ({
  error,
  ownerToken,
  sessionId,
}: {
  error: unknown
  ownerToken: string
  sessionId: string
}) => {
  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId})
  const upload =
    current === null ? null : getUploadMetadataFromProgress(toProjectTransferSessionResponse(current).progress)

  return repository.transitionProjectTransferSessionState({
    error: getErrorPayload(error),
    expectedOwnerToken: ownerToken,
    expectedState: ['extracting', 'analyzing'],
    nextOwnerToken: null,
    nextState: 'failed',
    progress: getAnalyzeProgress({now: new Date(), phase: 'analyze', status: 'failed', upload}),
    sessionId,
  })
}

const getAnalyzeJobAttempt = async (params: {ownerToken: string; sessionId: string}) => {
  try {
    return await runProjectTransferImportAnalyzeJob(params)
  } catch (error) {
    await failProjectTransferImportAnalyzeSession({...params, error})
    throw error
  }
}

const startBackgroundAnalyzeJob = (params: {ownerToken: string; sessionId: string}) => {
  queueMicrotask(() => {
    void getAnalyzeJobAttempt(params).catch((error) => {
      console.error('Project transfer import analyze job failed', error)
    })
  })
}

const getExportSourceProjectError = async (
  set: RouteSet,
  projectId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferExportResponse> | null> => {
  const project = await getProjectTransferExportSourceProject(projectId)

  if (project === null) {
    return getProjectTransferApiError(set, 404, 'Project not found')
  }

  if (project.deletePendingAt !== null && project.deletePendingAt !== undefined) {
    return getProjectTransferApiError(set, 409, 'Project is pending permanent deletion')
  }

  return null
}

const getHeaderSafeFilename = (filename: string) => {
  const safeFilename = filename.replace(/[\r\n"\\;/]/g, '_').trim()

  return safeFilename === '' ? 'project-transfer-export.zip' : safeFilename
}

const getAttachmentContentDisposition = (filename: string) => {
  return `attachment; filename="${getHeaderSafeFilename(filename)}"`
}

const getProjectTransferPackageHeaders = (metadata: ProjectTransferPackageHeaderMetadata) => {
  return {
    'content-disposition': getAttachmentContentDisposition(metadata.filename),
    'content-length': String(metadata.byteLength),
    'content-type': 'application/zip',
    'x-project-transfer-checksum-sha256': metadata.checksumSha256,
    'x-project-transfer-expires-at': metadata.expiresAt,
    'x-project-transfer-package-fingerprint': metadata.packageFingerprint,
  }
}

const getArrayBufferBody = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const hasSessionExpired = (response: ProjectTransferSessionResponse, now: Date) => {
  return response.expiresAt.getTime() <= now.getTime()
}

const isProjectTransferExportNonReadyStatus = (
  state: ProjectTransferSessionResponse['state'],
): state is ProjectTransferExportNonReadyStatus => {
  return state === 'queued' || state === 'assembling' || state === 'packaging'
}

const getReadyExportSessionData = (
  response: ProjectTransferSessionResponse,
  completion: ProjectTransferExportReadyPayload,
): ProjectTransferExportSessionReadyResponse => {
  return {
    byteLength: completion.byteLength,
    checksumSha256: completion.checksumSha256,
    downloadUrl: completion.downloadUrl,
    expiresAt: completion.expiresAt,
    exportId: response.id,
    filename: completion.filename,
    packageFingerprint: completion.packageFingerprint,
    progress: response.progress,
    status: 'ready',
  }
}

const getExportSessionData = (response: ProjectTransferSessionResponse): ProjectTransferExportSessionData | null => {
  if (isProjectTransferExportNonReadyStatus(response.state)) {
    return {
      exportId: response.id,
      expiresAt: response.expiresAt.toISOString(),
      progress: response.progress,
      status: response.state,
    }
  }

  return response.state === 'ready' && response.completion?.status === 'ready'
    ? getReadyExportSessionData(response, response.completion)
    : null
}

const getExportSessionError = (
  response: ProjectTransferSessionResponse,
  now: Date,
): {error: string; status: number} | null => {
  if (response.direction !== 'export') {
    return {error: 'Project transfer session is not an export session', status: 409}
  }

  if (response.state === 'failed') {
    return {error: 'Project transfer export failed', status: 409}
  }

  if (response.state === 'expired' || hasSessionExpired(response, now)) {
    return {error: 'Project transfer export session expired', status: 410}
  }

  if (response.state === 'ready' && response.completion?.status !== 'ready') {
    return {error: 'Project transfer export metadata is unavailable', status: 409}
  }

  return null
}

const getExportSessionResponse = async (
  set: RouteSet,
  exportId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferExportSessionData>> => {
  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId: exportId})

  if (record === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer export session not found')
  }

  const response = toProjectTransferSessionResponse(record)
  const sessionError = getExportSessionError(response, new Date())

  if (sessionError !== null) {
    return getProjectTransferApiError(set, sessionError.status, sessionError.error)
  }

  const data = getExportSessionData(response)

  return data === null
    ? getProjectTransferApiError(set, 409, 'Project transfer export session state is unavailable')
    : {data, error: null}
}

const getDownloadResponse = async (set: RouteSet, exportId: string) => {
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

const createImportSession = async (
  set: RouteSet,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<CreateImportSessionRequest>(body, createImportSessionRequestShape, [
    'expiresAt',
    'packageFingerprint',
    'sessionId',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const now = new Date()
  const sessionId = getImportSessionId(request.value.sessionId)

  if (!sessionId.ok) {
    return getProjectTransferApiError(set, 400, sessionId.error)
  }

  const expiresAt = parseImportSessionExpiresAt(request.value.expiresAt, now)

  if (!expiresAt.ok) {
    return getProjectTransferApiError(set, 400, expiresAt.error)
  }

  const repository = getProjectTransferSessionRepository()
  const existing = await repository.getProjectTransferSession({sessionId: sessionId.value})

  if (existing !== null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import session already exists')
  }

  const record = await repository.createProjectTransferSession({
    direction: 'import',
    expiresAt: expiresAt.value,
    id: sessionId.value,
    now,
    packageFingerprint: request.value.packageFingerprint ?? null,
    state: 'awaiting_upload',
  })

  set.status = 201

  return (
    getImportSessionResponseFromRecord(record) ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}

const getImportSession = async (
  set: RouteSet,
  sessionId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId})
  const response = getImportSessionResponseFromRecord(record)

  return response === null
    ? getProjectTransferApiError(set, 404, 'Project transfer import session not found')
    : response.error === null
      ? response
      : getProjectTransferApiError(set, 409, response.error)
}

const uploadImportPackage = async ({
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
  const currentResponse = getImportSessionResponseFromRecord(current)

  if (currentResponse === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer import session not found')
  }

  if (currentResponse.error !== null) {
    return getProjectTransferApiError(set, 409, currentResponse.error)
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

  const upload = await getUploadWriteAttempt({
    fileName: getUploadFileName(request),
    request,
    sessionId: params.sessionId,
  })

  if (!upload.ok) {
    await repository.transitionProjectTransferSessionState({
      error: getErrorPayload(upload.error),
      expectedOwnerToken: ownerToken,
      expectedState: 'uploading',
      nextOwnerToken: null,
      nextState: 'failed',
      progress: getUploadProgress({metadata: null, now: new Date(), status: 'failed'}),
      sessionId: params.sessionId,
    })

    return getProjectTransferApiError(set, 500, 'Project transfer upload failed')
  }

  const completedAt = new Date()
  const queued = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'uploading',
    nextOwnerToken: null,
    nextState: 'queued',
    now: completedAt,
    progress: getUploadProgress({metadata: upload.metadata, now: completedAt, status: 'completed'}),
    sessionId: params.sessionId,
  })

  return queued === null
    ? getProjectTransferApiError(set, 409, 'Project transfer import session upload ownership was lost')
    : (getImportSessionResponseFromRecord(queued) ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
}

const analyzeImportSession = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<AnalyzeImportSessionRequest>(body, analyzeImportSessionRequestShape, [
    'expectedPlanRevision',
    'expandedBytes',
    'zipBytes',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const repository = getProjectTransferSessionRepository()
  const current = await repository.getProjectTransferSession({sessionId})
  const currentResponse = getImportSessionResponseFromRecord(current)

  if (currentResponse === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer import session not found')
  }

  if (currentResponse.error !== null) {
    return getProjectTransferApiError(set, 409, currentResponse.error)
  }

  if (currentResponse.data.state !== 'queued') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session is not queued for analysis')
  }

  const upload = currentResponse.data.upload

  if (upload === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import upload metadata is unavailable')
  }

  const executionMode = getProjectTransferImportAnalyzeExecutionMode({
    expandedBytes: request.value.expandedBytes ?? 0,
    zipBytes: request.value.zipBytes ?? upload.byteLength,
  })
  const ownerToken = randomUUID()
  const claimedAt = new Date()
  const claimed = await repository.transitionProjectTransferSessionState({
    expectedOwnerToken: null,
    expectedPlanRevision: request.value.expectedPlanRevision,
    expectedState: 'queued',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'extracting',
    now: claimedAt,
    progress: getAnalyzeProgress({now: claimedAt, phase: 'extract', status: 'running', upload}),
    sessionId,
  })

  if (claimed === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import analysis could not be claimed')
  }

  if (executionMode === 'background') {
    set.status = 202
    startBackgroundAnalyzeJob({ownerToken, sessionId})
    return (
      getImportSessionResponseFromRecord(claimed, executionMode)
      ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
    )
  }

  const analyzed = await getAnalyzeJobAttempt({ownerToken, sessionId})

  return analyzed === null
    ? getProjectTransferApiError(set, 409, 'Project transfer import analysis ownership was lost')
    : (getImportSessionResponseFromRecord(analyzed, executionMode)
        ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
}

const resolveImportDependencies = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<ResolveImportDependenciesRequest>(body, resolveImportDependenciesRequestShape, [
    'expectedPlanRevision',
    'resolutions',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const response = await getImportSession(set, sessionId)

  if (response.error !== null) {
    return response
  }

  if (
    request.value.expectedPlanRevision !== undefined
    && response.data.planRevision !== request.value.expectedPlanRevision
  ) {
    return getProjectTransferApiError(set, 409, 'Project transfer import plan revision is stale')
  }

  return response.data.state === 'awaiting_resolution' || response.data.state === 'ready_to_commit'
    ? response
    : getProjectTransferApiError(set, 409, 'Project transfer import session is not awaiting dependency resolution')
}

const commitImportSession = (
  set: RouteSet,
  body: unknown,
): ProjectTransferApiResponse<ProjectTransferPlaceholderData> => {
  const request = parseRequestBody<CommitImportSessionRequest>(body, commitImportSessionRequestShape, [
    'expectedOwnerToken',
    'expectedPlanRevision',
  ])

  return request.ok
    ? getPlaceholderResponse(set, 'commit-import-session')
    : getProjectTransferApiError(set, 400, request.error)
}

const getCancelRequestDefaults = (request: CancelImportSessionRequest) => {
  return {
    cleanupTempArtifacts: request.cleanupTempArtifacts ?? true,
    expectedOwnerToken: request.expectedOwnerToken,
    reason: request.reason ?? 'user_cancelled',
  }
}

const getCancelNextState = (reason: ProjectTransferCancellationReason) => {
  return reason === 'session_expired' ? 'expired' : 'cancelled'
}

const isEmptyRequestBody = (body: unknown) => {
  return body === null || body === undefined || (isRecord(body) && Object.keys(body).length === 0)
}

const getCancellationMetadata = (error: unknown) => {
  return isRecord(error) ? error : {}
}

const isMatchingTerminalCancellationRequest = ({
  body,
  request,
  response,
}: {
  body: unknown
  request: ReturnType<typeof getCancelRequestDefaults>
  response: ProjectTransferImportSessionData
}) => {
  if (isEmptyRequestBody(body)) {
    return true
  }

  const metadata = getCancellationMetadata(response.error)
  const reasonMatches = metadata.reason === undefined || request.reason === metadata.reason
  const cleanupMatches =
    metadata.cleanupTempArtifacts === undefined || request.cleanupTempArtifacts === metadata.cleanupTempArtifacts

  return reasonMatches && cleanupMatches
}

const getCancelProgress = ({
  cleanupTempArtifacts,
  now,
  upload,
}: {
  cleanupTempArtifacts: boolean
  now: Date
  upload: ProjectTransferUploadMetadataPayload | null
}): ProjectTransferProgressPayload => {
  return {
    phase: 'cleanup',
    status: cleanupTempArtifacts ? 'completed' : 'pending',
    updatedAt: now.toISOString(),
    uploadMetadata: upload,
  }
}

const cleanupCancelledImportSession = async ({
  cleanupTempArtifacts,
  ownerToken,
  sessionId,
  state,
}: {
  cleanupTempArtifacts: boolean
  ownerToken: string
  sessionId: string
  state: 'cancelled' | 'expired'
}) => {
  if (cleanupTempArtifacts) {
    const rootPath = resolveProjectTransferTempWritablePath({
      pathValue: getProjectTransferImportTempLayout(sessionId).rootPath,
    })
    await rm(rootPath, {force: true, recursive: true})
  }

  return getProjectTransferSessionRepository().markProjectTransferSessionTerminalCleanupComplete({
    expectedOwnerToken: ownerToken,
    expectedState: state,
    sessionId,
  })
}

const cancelImportSession = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const parsedRequest = parseRequestBody<CancelImportSessionRequest>(body, cancelImportSessionRequestShape, [
    'cleanupTempArtifacts',
    'expectedOwnerToken',
    'reason',
  ])

  if (!parsedRequest.ok) {
    return getProjectTransferApiError(set, 400, parsedRequest.error)
  }

  const response = await getImportSession(set, sessionId)

  if (response.error !== null) {
    return response
  }

  const request = getCancelRequestDefaults(parsedRequest.value)

  if (response.data.state === 'cancelled' || response.data.state === 'expired') {
    return isMatchingTerminalCancellationRequest({body, request, response: response.data})
      ? response
      : getProjectTransferApiError(set, 409, 'Project transfer import session terminal cleanup request does not match')
  }

  if (response.data.state === 'committing' || response.data.state === 'completed' || response.data.state === 'failed') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session cannot be cancelled from this state')
  }

  const ownerToken = randomUUID()
  const cancelledAt = new Date()
  const nextState = getCancelNextState(request.reason)
  const cancelled = await getProjectTransferSessionRepository().cancelProjectTransferImportSession({
    error: {cleanupTempArtifacts: request.cleanupTempArtifacts, reason: request.reason},
    expectedOwnerToken: request.expectedOwnerToken,
    expectedState: [
      'awaiting_upload',
      'uploading',
      'queued',
      'extracting',
      'analyzing',
      'awaiting_resolution',
      'ready_to_commit',
    ],
    nextState,
    now: cancelledAt,
    ownerToken,
    progress: getCancelProgress({
      cleanupTempArtifacts: request.cleanupTempArtifacts,
      now: cancelledAt,
      upload: response.data.upload,
    }),
    sessionId,
  })

  if (cancelled === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import session cancellation could not be claimed')
  }

  const cleaned = await cleanupCancelledImportSession({
    cleanupTempArtifacts: request.cleanupTempArtifacts,
    ownerToken,
    sessionId,
    state: nextState,
  })

  return (
    getImportSessionResponseFromRecord(cleaned ?? cancelled)
    ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}

export const projectTransferRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/projects/:id/export-project',
    async ({params, set}) => {
      const sourceProjectError = await getExportSourceProjectError(set, params.id)

      if (sourceProjectError !== null) {
        return sourceProjectError
      }

      const result = await createProjectTransferExport({projectId: params.id})

      if (result.executionMode === 'inline') {
        return new Response(getArrayBufferBody(result.packageBytes), {
          headers: getProjectTransferPackageHeaders(result.metadata),
        })
      }

      set.status = 202

      return {
        data: {
          downloadUrl: result.metadata.downloadUrl,
          expiresAt: result.metadata.expiresAt,
          exportId: result.sessionId,
          filename: result.metadata.filename,
          status: 'queued',
        },
        error: null,
      }
    },
    {body: exportProjectBodySchema, params: routeParamSchema},
  )
  .get(
    '/api/projects/export/:exportId',
    async ({params, set}) => {
      return getExportSessionResponse(set, params.exportId)
    },
    {params: exportParamSchema},
  )
  .get(
    '/api/projects/export/:exportId/download',
    ({params, set}) => {
      return getDownloadResponse(set, params.exportId)
    },
    {params: exportParamSchema},
  )
  .post('/api/projects/import/sessions', ({body, set}) => {
    return createImportSession(set, body)
  })
  .put(
    '/api/projects/import/:sessionId/upload',
    ({params, request, set}) => {
      return uploadImportPackage({params, request, set})
    },
    {params: importSessionParamSchema, parse: 'none'},
  )
  .post(
    '/api/projects/import/:sessionId/analyze',
    ({body, params, set}) => {
      return analyzeImportSession(set, params.sessionId, body)
    },
    {params: importSessionParamSchema},
  )
  .get(
    '/api/projects/import/:sessionId',
    ({params, set}) => {
      return getImportSession(set, params.sessionId)
    },
    {params: importSessionParamSchema},
  )
  .post(
    '/api/projects/import/:sessionId/resolve-dependencies',
    ({body, params, set}) => {
      return resolveImportDependencies(set, params.sessionId, body)
    },
    {params: importSessionParamSchema},
  )
  .post(
    '/api/projects/import/:sessionId/commit',
    ({body, set}) => {
      return commitImportSession(set, body)
    },
    {params: importSessionParamSchema},
  )
  .delete(
    '/api/projects/import/:sessionId',
    ({body, params, set}) => {
      return cancelImportSession(set, params.sessionId, body)
    },
    {params: importSessionParamSchema},
  )

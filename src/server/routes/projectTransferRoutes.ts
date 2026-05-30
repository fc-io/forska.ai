import {createHash, randomUUID} from 'node:crypto'
import {createWriteStream, type WriteStream} from 'node:fs'
import {mkdir, rename, rm, statfs} from 'node:fs/promises'
import {dirname} from 'node:path'

import {type as arktype} from 'arktype'
import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  analyzeProjectTransferImportPackage,
  type ProjectTransferImportPlanArtifact,
} from '../services/projectTransfer/projectTransferAnalyze.ts'
import {commitProjectTransferImportSession} from '../services/projectTransfer/projectTransferCommit.ts'
import {
  getProjectTransferImportAnalyzeExecutionMode,
  type ProjectTransferApiResponse,
  type ProjectTransferCancellationReason,
  type ProjectTransferExecutionMode,
  type ProjectTransferExportReadyPayload,
  type ProjectTransferPlanSummary,
  type ProjectTransferProgressPayload,
  type ProjectTransferSessionResponse,
  type ProjectTransferUploadMetadataPayload,
  validateProjectTransferPlanReadyToCommit,
  validateProjectTransferResourceGates,
} from '../services/projectTransfer/projectTransferContracts.ts'
import {
  type ProjectTransferDependencyResolutionRequest,
  resolveProjectTransferDependencies,
} from '../services/projectTransfer/projectTransferDependencyResolution.ts'
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
  plan: ProjectTransferImportPlanArtifact | null
  resolveDependenciesUrl: string
  sessionUrl: string
  stalePlan?: boolean
  upload: ProjectTransferUploadMetadataPayload | null
  uploadUrl: string
  warnings: string[]
}
type ProjectTransferSourceProjectRow = {deletePendingAt: unknown; id: string}
type RouteSet = {status?: number | string}
type ProjectTransferPackageHeaderMetadata = Pick<
  ProjectTransferExportReadyPayload,
  'byteLength' | 'checksumSha256' | 'expiresAt' | 'filename' | 'packageFingerprint'
>

const importWorkerHeartbeatIntervalMs = 15_000
const importWorkerHeartbeatLeaseMs = 60_000

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
const dependencyProviderSelectionShape = arktype({
  sourceProviderConnectionId: 'string',
  targetProviderConnectionId: 'string',
})
const dependencyCreatedProviderHandoffShape = arktype({
  'setupState?': '"auth_pending" | "complete" | "connection_test_pending" | "discovery_pending"',
  sourceProviderConnectionId: 'string',
  targetProviderConnectionId: 'string',
})
const dependencyModelSelectionShape = arktype({
  'acceptSubstitute?': 'boolean',
  sourceModelId: 'string',
  targetModelId: 'string',
})
const dependencyMaterializedModelHandoffShape = arktype({
  'acceptSubstitute?': 'boolean',
  sourceModelId: 'string',
  targetModelId: 'string',
  'targetProviderConnectionId?': 'string',
})
const dependencyModelOptionsShape = arktype({'thinking?': 'string | null'})
const dependencyModelMaterializationRequestShape = arktype({
  'displayName?': 'string',
  'options?': dependencyModelOptionsShape,
  remoteModelId: 'string',
  sourceModelId: 'string',
  targetProviderConnectionId: 'string',
  'variant?': 'string | null',
})
const dependencyUnresolvedProviderShape = arktype({
  'reason?': 'string',
  sourceProviderConnectionId: 'string',
  'status?': '"ambiguous" | "blocked" | "missing"',
})
const dependencyUnresolvedModelShape = arktype({
  'reason?': 'string',
  sourceModelId: 'string',
  'status?': '"ambiguous" | "blocked" | "missing"',
})
const resolveImportDependenciesRequestShape = arktype({
  'autoResolve?': 'boolean',
  'codexSetupState?': '"complete" | "login_pending" | "not_ready" | "setup_pending"',
  'createdProviderConnections?': dependencyCreatedProviderHandoffShape.array(),
  'materializedModels?': dependencyMaterializedModelHandoffShape.array(),
  'modelMaterializationRequests?': dependencyModelMaterializationRequestShape.array(),
  planRevision: 'number.integer >= 0',
  'selectedModels?': dependencyModelSelectionShape.array(),
  'selectedProviderConnections?': dependencyProviderSelectionShape.array(),
  'unresolvedModels?': dependencyUnresolvedModelShape.array(),
  'unresolvedProviders?': dependencyUnresolvedProviderShape.array(),
})
const commitImportSessionRequestShape = arktype({
  'expectedPlanRevision?': 'number.integer >= 0',
  'planRevision?': 'number.integer >= 0',
})
const cancelImportSessionRequestShape = arktype({
  'cleanupTempArtifacts?': 'boolean',
  'expectedOwnerToken?': 'string',
  'reason?': arktype('"cleanup_failed" | "session_expired" | "user_cancelled"'),
})
type CreateImportSessionRequest = typeof createImportSessionRequestShape.infer
type AnalyzeImportSessionRequest = typeof analyzeImportSessionRequestShape.infer
type ResolveImportDependenciesRequest = ProjectTransferDependencyResolutionRequest
type CommitImportSessionRequest = typeof commitImportSessionRequestShape.infer
type CancelImportSessionRequest = typeof cancelImportSessionRequestShape.infer

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

const getUnexpectedNestedArrayKey = ({allowedKeys, value}: {allowedKeys: readonly string[]; value: unknown}) => {
  if (!Array.isArray(value)) {
    return null
  }

  return (
    value
      .map((entry, index) => {
        return isRecord(entry) ? {index, key: getUnexpectedBodyKey(entry, allowedKeys) ?? null} : {index, key: null}
      })
      .find((entry) => {
        return entry.key !== null
      }) ?? null
  )
}

const validateResolveDependenciesNestedKeys = (
  body: Record<string, unknown>,
): {error: string; ok: false} | {ok: true} => {
  const nestedChecks = [
    {allowedKeys: ['sourceProviderConnectionId', 'targetProviderConnectionId'], field: 'selectedProviderConnections'},
    {
      allowedKeys: ['setupState', 'sourceProviderConnectionId', 'targetProviderConnectionId'],
      field: 'createdProviderConnections',
    },
    {allowedKeys: ['acceptSubstitute', 'sourceModelId', 'targetModelId'], field: 'selectedModels'},
    {
      allowedKeys: ['acceptSubstitute', 'sourceModelId', 'targetModelId', 'targetProviderConnectionId'],
      field: 'materializedModels',
    },
    {
      allowedKeys: [
        'displayName',
        'options',
        'remoteModelId',
        'sourceModelId',
        'targetProviderConnectionId',
        'variant',
      ],
      field: 'modelMaterializationRequests',
    },
    {allowedKeys: ['reason', 'sourceProviderConnectionId', 'status'], field: 'unresolvedProviders'},
    {allowedKeys: ['reason', 'sourceModelId', 'status'], field: 'unresolvedModels'},
  ] as const
  const invalidNestedKey =
    nestedChecks
      .map((check) => {
        const invalid = getUnexpectedNestedArrayKey({...check, value: body[check.field]})

        return invalid ? {...invalid, field: check.field} : null
      })
      .find((entry) => {
        return entry !== null
      }) ?? null

  return invalidNestedKey === null
    ? {ok: true}
    : {
        error:
          `Project transfer request body contains unsupported field ${invalidNestedKey.field}`
          + `[${invalidNestedKey.index}].${invalidNestedKey.key}`,
        ok: false,
      }
}

const parseResolveDependenciesRequest = (
  body: unknown,
): {error: string; ok: false} | {ok: true; value: ResolveImportDependenciesRequest} => {
  const allowedKeys = [
    'autoResolve',
    'codexSetupState',
    'createdProviderConnections',
    'materializedModels',
    'modelMaterializationRequests',
    'planRevision',
    'selectedModels',
    'selectedProviderConnections',
    'unresolvedModels',
    'unresolvedProviders',
  ]
  const request = parseRequestBody<ResolveImportDependenciesRequest>(
    body,
    resolveImportDependenciesRequestShape,
    allowedKeys,
  )

  if (!request.ok) {
    return request
  }

  const nestedValidation = validateResolveDependenciesNestedKeys((body ?? {}) as Record<string, unknown>)

  return nestedValidation.ok ? request : nestedValidation
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

const readImportPlanArtifact = async (sessionId: string): Promise<ProjectTransferImportPlanArtifact | null> => {
  const planPath = resolveProjectTransferTempWritablePath({
    pathValue: getProjectTransferImportTempLayout(sessionId).planPath,
  })
  const planFile = globalThis.Bun.file(planPath)

  return (await planFile.exists()) ? (JSON.parse(await planFile.text()) as ProjectTransferImportPlanArtifact) : null
}

const getImportSessionData = (
  response: ProjectTransferSessionResponse,
  plan: ProjectTransferImportPlanArtifact | null,
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
    plan,
    upload: getUploadMetadataFromProgress(response.progress),
    warnings: getImportSessionWarnings(response.planSummary),
  }
}

const getImportSessionError = (
  response: ProjectTransferSessionResponse,
  now: Date,
): {error: string; status: number} | null => {
  return response.state !== 'completed' && (response.state === 'expired' || hasSessionExpired(response, now))
    ? {error: 'Project transfer import session expired', status: 410}
    : null
}

const getImportSessionResponseFromRecord = async (
  set: RouteSet,
  record: Awaited<ReturnType<ReturnType<typeof getProjectTransferSessionRepository>['getProjectTransferSession']>>,
  executionMode?: ProjectTransferExecutionMode,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData> | null> => {
  if (record === null) {
    return null
  }

  const response = toProjectTransferSessionResponse(record)

  if (response.direction !== 'import') {
    return getProjectTransferApiError(set, 409, 'Project transfer session is not an import session')
  }

  const sessionError = getImportSessionError(response, new Date())

  if (sessionError !== null) {
    return getProjectTransferApiError(set, sessionError.status, sessionError.error)
  }

  const plan = await readImportPlanArtifact(response.id)

  return {data: getImportSessionData(response, plan, executionMode), error: null}
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

const getAvailableDiskBytes = async (pathValue: string) => {
  const stats = await statfs(pathValue)

  return Number(stats.bavail) * Number(stats.bsize)
}

const getUploadResourceGateError = ({
  availableDiskBytes,
  byteLength,
  tempRootPath,
}: {
  availableDiskBytes: number
  byteLength: number
  tempRootPath: string
}) => {
  const validation = validateProjectTransferResourceGates({
    availableDiskBytes,
    fileBytes: byteLength,
    targetWriteBytes: byteLength,
    tempRootPath,
    usesStreamingParser: true,
    zipBytes: byteLength,
  })

  if (validation.ok) {
    return null
  }

  const error = new Error(`Project transfer upload ${validation.error}`)
  error.name = 'ProjectTransferUploadResourceGateError'

  return error
}

const assertUploadResourceGate = (input: {availableDiskBytes: number; byteLength: number; tempRootPath: string}) => {
  const error = getUploadResourceGateError(input)

  if (error !== null) {
    throw error
  }
}

const isUploadResourceGateError = (error: unknown) => {
  return error instanceof Error && error.name === 'ProjectTransferUploadResourceGateError'
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
  const availableDiskBytes = await getAvailableDiskBytes(dirname(uploadPath))

  const fileStream = createWriteStream(tempPath)
  const stream = new WritableStream<Uint8Array>({
    abort(reason) {
      fileStream.destroy(reason instanceof Error ? reason : undefined)
    },
    close() {
      return closeFileStream(fileStream)
    },
    write(chunk) {
      const nextByteLength = state.byteLength + chunk.byteLength
      assertUploadResourceGate({availableDiskBytes, byteLength: nextByteLength, tempRootPath: layout.rootPath})
      state.byteLength = nextByteLength
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

const refreshProjectTransferImportWorkerHeartbeat = async ({
  ownerToken,
  sessionId,
}: {
  ownerToken: string
  sessionId: string
}) => {
  const heartbeat = await getProjectTransferSessionRepository().heartbeatProjectTransferSessionOwner({
    leaseMs: importWorkerHeartbeatLeaseMs,
    ownerToken,
    sessionId,
  })

  if (heartbeat === null) {
    throw new Error(`Project transfer import session ownership was lost: ${sessionId}`)
  }

  return heartbeat
}

const runProjectTransferImportWorkerHeartbeat = async <TValue>({
  operation,
  ownerToken,
  sessionId,
}: {
  operation: () => Promise<TValue>
  ownerToken: string
  sessionId: string
}) => {
  const interval = setInterval(() => {
    void refreshProjectTransferImportWorkerHeartbeat({ownerToken, sessionId}).catch((error) => {
      console.error('Project transfer import worker heartbeat failed', error)
    })
  }, importWorkerHeartbeatIntervalMs)

  return operation().finally(() => {
    clearInterval(interval)
  })
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
  return validateProjectTransferPlanReadyToCommit(planSummary).ok ? 'ready_to_commit' : 'awaiting_resolution'
}

const getImportAnalyzeExecutionMode = ({
  expandedBytes,
  zipBytes,
}: {
  expandedBytes?: number
  zipBytes: number
}): ProjectTransferExecutionMode => {
  return expandedBytes === undefined
    ? 'background'
    : getProjectTransferImportAnalyzeExecutionMode({expandedBytes, zipBytes})
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

  const analysis = await runProjectTransferImportWorkerHeartbeat({
    operation: () => {
      return analyzeProjectTransferImportPackage({
        layout: getProjectTransferImportTempLayout(sessionId),
        planRevision: analyzing.planRevision + 1,
        uploadMetadata: upload,
      })
    },
    ownerToken,
    sessionId,
  })
  const completedAt = new Date()
  const completedProgress = getCompletedAnalyzeProgress({now: completedAt, planSummary: analysis.planSummary, upload})
  const nextState = getImportAnalyzeNextState(analysis.planSummary)
  const planned = await repository.updateProjectTransferSessionPlanRevision({
    expectedOwnerToken: ownerToken,
    expectedPlanRevision: analyzing.planRevision,
    nextOwnerToken: null,
    nextState,
    now: completedAt,
    packageFingerprint: analysis.packageFingerprint,
    planSummary: analysis.planSummary,
    progress: completedProgress,
    sessionId,
  })

  return planned
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
    (await getImportSessionResponseFromRecord(set, record))
    ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
  )
}

const getImportSession = async (
  set: RouteSet,
  sessionId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId})
  const response = await getImportSessionResponseFromRecord(set, record)

  return response === null
    ? getProjectTransferApiError(set, 404, 'Project transfer import session not found')
    : response
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

  const upload = await runProjectTransferImportWorkerHeartbeat({
    operation: () => {
      return getUploadWriteAttempt({fileName: getUploadFileName(request), request, sessionId: params.sessionId})
    },
    ownerToken,
    sessionId: params.sessionId,
  })

  if (!upload.ok) {
    const uploadErrorMessage = isUploadResourceGateError(upload.error)
      ? (upload.error as Error).message
      : 'Project transfer upload failed'

    await repository.transitionProjectTransferSessionState({
      error: getErrorPayload(upload.error),
      expectedOwnerToken: ownerToken,
      expectedState: 'uploading',
      nextOwnerToken: null,
      nextState: 'failed',
      progress: getUploadProgress({metadata: null, now: new Date(), status: 'failed'}),
      sessionId: params.sessionId,
    })

    return getProjectTransferApiError(set, isUploadResourceGateError(upload.error) ? 413 : 500, uploadErrorMessage)
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
    : ((await getImportSessionResponseFromRecord(set, queued))
        ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
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
  const currentResponse = await getImportSessionResponseFromRecord(set, current)

  if (currentResponse === null) {
    return getProjectTransferApiError(set, 404, 'Project transfer import session not found')
  }

  if (currentResponse.error !== null) {
    return currentResponse
  }

  if (currentResponse.data.state !== 'queued') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session is not queued for analysis')
  }

  const upload = currentResponse.data.upload

  if (upload === null) {
    return getProjectTransferApiError(set, 409, 'Project transfer import upload metadata is unavailable')
  }

  const executionMode = getImportAnalyzeExecutionMode({
    expandedBytes: request.value.expandedBytes,
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
      (await getImportSessionResponseFromRecord(set, claimed, executionMode))
      ?? getProjectTransferApiError(set, 500, 'Import session unavailable')
    )
  }

  const analyzed = await getAnalyzeJobAttempt({ownerToken, sessionId})

  return analyzed === null
    ? getProjectTransferApiError(set, 409, 'Project transfer import analysis ownership was lost')
    : ((await getImportSessionResponseFromRecord(set, analyzed, executionMode))
        ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
}

const resolveImportDependencies = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseResolveDependenciesRequest(body)

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const response = await getImportSession(set, sessionId)

  if (response.error !== null) {
    return response
  }

  if (response.data.planRevision !== request.value.planRevision) {
    return {data: {...response.data, stalePlan: true}, error: null}
  }

  if (response.data.state !== 'awaiting_resolution' && response.data.state !== 'ready_to_commit') {
    return getProjectTransferApiError(set, 409, 'Project transfer import session is not awaiting dependency resolution')
  }

  const result = await resolveProjectTransferDependencies({
    layout: getProjectTransferImportTempLayout(sessionId),
    nextPlanRevision: response.data.planRevision + 1,
    request: request.value,
  })

  if (result.status === 'error') {
    return getProjectTransferApiError(set, result.statusCode, result.error)
  }

  if (!result.changed) {
    return response
  }

  const updated = await getProjectTransferSessionRepository().updateProjectTransferSessionPlanRevision({
    expectedPlanRevision: response.data.planRevision,
    nextState: getImportAnalyzeNextState(result.planSummary),
    now: new Date(),
    planSummary: result.planSummary,
    sessionId,
  })

  return updated === null
    ? getProjectTransferApiError(set, 409, 'Project transfer import dependency resolution could not update the plan')
    : ((await getImportSessionResponseFromRecord(set, updated))
        ?? getProjectTransferApiError(set, 500, 'Import session unavailable'))
}

const getCommitRequestRevision = (
  request: CommitImportSessionRequest,
): {error: string; ok: false} | {ok: true; request: CommitImportSessionRequest} => {
  const hasPlanRevision = request.planRevision !== undefined
  const hasExpectedPlanRevision = request.expectedPlanRevision !== undefined

  if (!hasPlanRevision && !hasExpectedPlanRevision) {
    return {error: 'Project transfer commit requires planRevision', ok: false}
  }

  if (hasPlanRevision && hasExpectedPlanRevision && request.planRevision !== request.expectedPlanRevision) {
    return {error: 'Project transfer commit planRevision and expectedPlanRevision conflict', ok: false}
  }

  if (hasPlanRevision && hasExpectedPlanRevision) {
    return {error: 'Project transfer commit requires exactly one reviewed plan revision', ok: false}
  }

  return {ok: true, request}
}

const getCommitSessionResponse = async ({
  executionMode,
  result,
  set,
  stalePlan,
}: {
  executionMode?: ProjectTransferExecutionMode
  result: Exclude<Awaited<ReturnType<typeof commitProjectTransferImportSession>>, {status: 'error'}>
  set: RouteSet
  stalePlan?: boolean
}): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  set.status = result.statusCode
  const response = await getImportSessionResponseFromRecord(set, result.session, executionMode)

  return response === null
    ? getProjectTransferApiError(set, 500, 'Import session unavailable')
    : stalePlan
      ? {data: {...response.data, stalePlan: true}, error: null}
      : response
}

const commitImportSession = async (
  set: RouteSet,
  sessionId: string,
  body: unknown,
): Promise<ProjectTransferApiResponse<ProjectTransferImportSessionData>> => {
  const request = parseRequestBody<CommitImportSessionRequest>(body, commitImportSessionRequestShape, [
    'expectedPlanRevision',
    'planRevision',
  ])

  if (!request.ok) {
    return getProjectTransferApiError(set, 400, request.error)
  }

  const revision = getCommitRequestRevision(request.value)

  if (!revision.ok) {
    return getProjectTransferApiError(set, 400, revision.error)
  }

  const result = await commitProjectTransferImportSession({request: revision.request, sessionId})

  if (result.status === 'error') {
    return getProjectTransferApiError(set, result.statusCode, result.error)
  }

  if (result.status === 'stale') {
    return getCommitSessionResponse({result, set, stalePlan: true})
  }

  if (result.status === 'claimed') {
    return getCommitSessionResponse({executionMode: result.executionMode, result, set})
  }

  return getCommitSessionResponse({result, set})
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
    (await getImportSessionResponseFromRecord(set, cleaned ?? cancelled))
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
    ({body, params, set}) => {
      return commitImportSession(set, params.sessionId, body)
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

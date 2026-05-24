import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  getProjectTransferPlaceholderResponse,
  type ProjectTransferApiResponse,
  type ProjectTransferExportReadyPayload,
  type ProjectTransferProgressPayload,
  type ProjectTransferSessionResponse,
  type ProjectTransferUploadSession,
} from '../services/projectTransfer/projectTransferContracts.ts'
import {
  createProjectTransferExport,
  type ProjectTransferExportPackageMetadata,
} from '../services/projectTransfer/projectTransferExportPackage.ts'
import {resolveProjectTransferTempWritablePath} from '../services/projectTransfer/projectTransferPaths.ts'
import {
  getProjectTransferExportTempLayout,
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
type ProjectTransferPlaceholderData =
  | ProjectTransferExportResponse
  | ProjectTransferExportSessionData
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
const createImportSessionBodySchema = t.Optional(
  t.Object(
    {
      expiresAt: t.Optional(t.String()),
      packageFingerprint: t.Optional(t.Nullable(t.String())),
      sessionId: t.Optional(t.String()),
    },
    {additionalProperties: true},
  ),
)
const uploadImportPackageBodySchema = t.Optional(t.Any())
const analyzeImportSessionBodySchema = t.Optional(t.Object({}, {additionalProperties: true}))
const resolveImportDependenciesBodySchema = t.Optional(t.Object({}, {additionalProperties: true}))
const commitImportSessionBodySchema = t.Optional(
  t.Object(
    {expectedOwnerToken: t.Optional(t.String()), expectedPlanRevision: t.Optional(t.Number({minimum: 0}))},
    {additionalProperties: true},
  ),
)
const deleteImportSessionBodySchema = t.Optional(
  t.Object(
    {
      cleanupTempArtifacts: t.Optional(t.Boolean()),
      expectedOwnerToken: t.Optional(t.String()),
      reason: t.Optional(
        t.Union([t.Literal('cleanup_failed'), t.Literal('session_expired'), t.Literal('user_cancelled')]),
      ),
    },
    {additionalProperties: true},
  ),
)

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
        return new Response(result.packageBytes, {headers: getProjectTransferPackageHeaders(result.metadata)})
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
  .post(
    '/api/projects/import/sessions',
    ({set}) => {
      return getPlaceholderResponse(set, 'create-import-session')
    },
    {body: createImportSessionBodySchema},
  )
  .put(
    '/api/projects/import/:sessionId/upload',
    ({set}) => {
      return getPlaceholderResponse(set, 'upload-import-package')
    },
    {body: uploadImportPackageBodySchema, params: importSessionParamSchema},
  )
  .post(
    '/api/projects/import/:sessionId/analyze',
    ({set}) => {
      return getPlaceholderResponse(set, 'analyze-import-session')
    },
    {body: analyzeImportSessionBodySchema, params: importSessionParamSchema},
  )
  .get(
    '/api/projects/import/:sessionId',
    ({set}) => {
      return getPlaceholderResponse(set, 'get-import-session')
    },
    {params: importSessionParamSchema},
  )
  .post(
    '/api/projects/import/:sessionId/resolve-dependencies',
    ({set}) => {
      return getPlaceholderResponse(set, 'resolve-import-dependencies')
    },
    {body: resolveImportDependenciesBodySchema, params: importSessionParamSchema},
  )
  .post(
    '/api/projects/import/:sessionId/commit',
    ({set}) => {
      return getPlaceholderResponse(set, 'commit-import-session')
    },
    {body: commitImportSessionBodySchema, params: importSessionParamSchema},
  )
  .delete(
    '/api/projects/import/:sessionId',
    ({set}) => {
      return getPlaceholderResponse(set, 'delete-import-session')
    },
    {body: deleteImportSessionBodySchema, params: importSessionParamSchema},
  )

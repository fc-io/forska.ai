import {Elysia, t} from 'elysia'

import {
  getProjectTransferPlaceholderResponse,
  type ProjectTransferApiResponse,
  type ProjectTransferSessionResponse,
  type ProjectTransferUploadSession,
} from '../services/projectTransfer/projectTransferContracts.ts'
import {createProjectTransferExport} from '../services/projectTransfer/projectTransferExportPackage.ts'
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
type ProjectTransferPlaceholderData =
  | ProjectTransferExportResponse
  | ProjectTransferSessionResponse
  | ProjectTransferUploadSession
type RouteSet = {status?: number | string}

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

const getSessionResponse = async (
  sessionId: string,
): Promise<ProjectTransferApiResponse<ProjectTransferSessionResponse>> => {
  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId})

  return record === null
    ? {data: null, error: 'Project transfer export session not found'}
    : {data: toProjectTransferSessionResponse(record), error: null}
}

const getDownloadResponse = async (set: RouteSet, exportId: string) => {
  const record = await getProjectTransferSessionRepository().getProjectTransferSession({sessionId: exportId})
  const response = record === null ? null : toProjectTransferSessionResponse(record)

  if (response === null) {
    set.status = 404
    return {data: null, error: 'Project transfer export session not found'}
  }

  if (response.direction !== 'export' || response.state !== 'ready' || response.completion?.status !== 'ready') {
    set.status = 409
    return {data: null, error: 'Project transfer export package is not ready'}
  }

  const packagePath = resolveProjectTransferTempWritablePath({
    pathValue: getProjectTransferExportTempLayout(exportId).packagePath,
  })
  const file = globalThis.Bun.file(packagePath)
  const exists = await file.exists()

  if (!exists) {
    set.status = 410
    return {data: null, error: 'Project transfer export package artifact is unavailable'}
  }

  return new Response(file, {
    headers: {
      'content-disposition': `attachment; filename="${response.completion.filename}"`,
      'content-type': 'application/zip',
    },
  })
}

export const projectTransferRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/projects/:id/export-project',
    async ({params, set}) => {
      const result = await createProjectTransferExport({projectId: params.id})

      if (result.executionMode === 'inline') {
        return new Response(result.packageBytes, {
          headers: {
            'content-disposition': `attachment; filename="${result.metadata.filename}"`,
            'content-type': 'application/zip',
            'x-project-transfer-checksum-sha256': result.metadata.checksumSha256,
            'x-project-transfer-expires-at': result.metadata.expiresAt,
            'x-project-transfer-package-fingerprint': result.metadata.packageFingerprint,
          },
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
      const response = await getSessionResponse(params.exportId)

      if (response.error) {
        set.status = 404
      }

      return response
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

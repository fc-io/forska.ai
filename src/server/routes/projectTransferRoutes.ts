import {Elysia, t} from 'elysia'

import {
  getProjectTransferPlaceholderResponse,
  type ProjectTransferApiResponse,
  type ProjectTransferSessionResponse,
  type ProjectTransferUploadSession,
} from '../services/projectTransfer/projectTransferContracts.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type ProjectTransferPlaceholderData = ProjectTransferSessionResponse | ProjectTransferUploadSession | {exportId: string}
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

export const projectTransferRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/projects/:id/export-project',
    ({set}) => {
      return getPlaceholderResponse(set, 'export-project')
    },
    {body: exportProjectBodySchema, params: routeParamSchema},
  )
  .get(
    '/api/projects/export/:exportId',
    ({set}) => {
      return getPlaceholderResponse(set, 'get-export')
    },
    {params: exportParamSchema},
  )
  .get(
    '/api/projects/export/:exportId/download',
    ({set}) => {
      return getPlaceholderResponse(set, 'download-export')
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

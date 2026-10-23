import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {getExportSessionResponse} from './projectTransferRoutes/getExportSessionResponse.ts'
import {getImportSession} from './projectTransferRoutes/getImportSession.ts'
import {cancelImportSession} from './projectTransferRoutes/projectTransferRoutesDeleteImport.ts'
import {getDownloadResponse} from './projectTransferRoutes/projectTransferRoutesGetExportDownload.ts'
import {projectTransferRoutesGetExportProject} from './projectTransferRoutes/projectTransferRoutesGetExportProject.ts'
import {projectTransferRoutesPostExportProject} from './projectTransferRoutes/projectTransferRoutesPostExportProject.ts'
import {analyzeImportSession} from './projectTransferRoutes/projectTransferRoutesPostImportAnalyze.ts'
import {commitImportSession} from './projectTransferRoutes/projectTransferRoutesPostImportCommit.ts'
import {resolveImportDependencies} from './projectTransferRoutes/projectTransferRoutesPostImportResolveDependencies.ts'
import {createImportSession} from './projectTransferRoutes/projectTransferRoutesPostImportSessions.ts'
import {uploadImportPackage} from './projectTransferRoutes/projectTransferRoutesPutImportUpload.ts'
import type {ProjectTransferRoutesDependencies} from './projectTransferRoutes/projectTransferRouteTypes.ts'

export {getExportSessionArtifactResponse} from './projectTransferRoutes/getExportSessionArtifactResponse.ts'
export {getImportSessionArtifactResponse} from './projectTransferRoutes/getImportSessionArtifactResponse.ts'
export {projectTransferRouteSpecs} from './projectTransferRoutes/projectTransferRouteSpecs.ts'
export {shouldUseImportSessionArtifactResponse} from './projectTransferRoutes/shouldUseImportSessionArtifactResponse.ts'

const routeParamSchema = t.Object({id: t.String({minLength: 1})})
const exportParamSchema = t.Object({exportId: t.String({minLength: 1})})
const importSessionParamSchema = t.Object({sessionId: t.String({minLength: 1})})
const exportProjectBodySchema = t.Optional(
  t.Object(
    {rawArticleProvenanceMode: t.Optional(t.Union([t.Literal('include'), t.Literal('omit')]))},
    {additionalProperties: true},
  ),
)

const defaultProjectTransferRoutesDependencies: ProjectTransferRoutesDependencies = {}

export const setProjectTransferRoutesDependenciesForTests = (dependencies: ProjectTransferRoutesDependencies) => {
  Object.assign(defaultProjectTransferRoutesDependencies, dependencies)
}

export const resetProjectTransferRoutesDependenciesForTests = () => {
  delete defaultProjectTransferRoutesDependencies.getExportSourceProject
}

export const createProjectTransferRoutes = (
  dependencies: ProjectTransferRoutesDependencies = defaultProjectTransferRoutesDependencies,
) => {
  return new Elysia()
    .use(withErrorHandler())
    .get(
      '/api/projects/:id/export-project',
      async ({params, set}) => {
        return projectTransferRoutesGetExportProject({dependencies, params, set})
      },
      {params: routeParamSchema},
    )
    .post(
      '/api/projects/:id/export-project',
      async ({body, params, set}) => {
        return projectTransferRoutesPostExportProject({body, dependencies, params, set})
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
      ({params, query, set}) => {
        return getImportSession(set, params.sessionId, query.includePlan === 'true')
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
}

export const projectTransferRoutes = createProjectTransferRoutes()

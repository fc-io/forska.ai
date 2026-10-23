import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {projectExportRoutesGetExport} from './projectExportRoutes/projectExportRoutesGetExport.ts'
import {projectExportRoutesGetExportDownload} from './projectExportRoutes/projectExportRoutesGetExportDownload.ts'
import {
  projectExportRoutesPostExport,
  projectExportRoutesPostExportBodySchema,
} from './projectExportRoutes/projectExportRoutesPostExport.ts'
import {projectExportRoutesPostExportPrompts} from './projectExportRoutes/projectExportRoutesPostExportPrompts.ts'

export const projectExportRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/projects/:id/export',
    async ({params, body, set}) => {
      return projectExportRoutesPostExport({body, params, set})
    },
    {body: projectExportRoutesPostExportBodySchema},
  )
  .get(
    '/api/projects/:id/export/:jobId',
    async ({params, set}) => {
      return projectExportRoutesGetExport({params, set})
    },
    {params: t.Object({id: t.String(), jobId: t.String()})},
  )
  .get(
    '/api/projects/:id/export/:jobId/download',
    async ({params, set}) => {
      return projectExportRoutesGetExportDownload({params, set})
    },
    {params: t.Object({id: t.String(), jobId: t.String()})},
  )
  .post(
    '/api/projects/:id/export-prompts',
    async ({params, body, set}) => {
      return projectExportRoutesPostExportPrompts({body, params, set})
    },
    {body: t.Object({promptIds: t.Array(t.String())})},
  )

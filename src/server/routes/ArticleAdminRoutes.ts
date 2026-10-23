import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {articleAdminRoutesGetAdminInfo} from './articleAdminRoutes/articleAdminRoutesGetAdminInfo.ts'
import {articleAdminRoutesPostCanonicalFullTextRebuild} from './articleAdminRoutes/articleAdminRoutesPostCanonicalFullTextRebuild.ts'
import {articleAdminRoutesPostConversionReconvert} from './articleAdminRoutes/articleAdminRoutesPostConversionReconvert.ts'
import {articleAdminRoutesPostConvertPdf} from './articleAdminRoutes/articleAdminRoutesPostConvertPdf.ts'
import {articleAdminRoutesPostFetchPdf} from './articleAdminRoutes/articleAdminRoutesPostFetchPdf.ts'
import {articleAdminRoutesPostUploadPdf} from './articleAdminRoutes/articleAdminRoutesPostUploadPdf.ts'
import {conversionReconvertBody} from './articleAdminRoutes/conversionReconvertBody.ts'

export const articleAdminRoutes = new Elysia()
  .use(withErrorHandler())
  // Extra article info (lightweight, for suspense boundary)
  .get(
    '/api/articles/:id/admin-info',
    async ({params}) => {
      return articleAdminRoutesGetAdminInfo({params})
    },
    {params: t.Object({id: t.String()})},
  )
  // Force refetch PDF for an article
  .post(
    '/api/articles/:id/fetch-pdf',
    async ({params}) => {
      return articleAdminRoutesPostFetchPdf({params})
    },
    {params: t.Object({id: t.String()})},
  )
  // Upload a PDF for an article
  .post(
    '/api/articles/:id/upload-pdf',
    async ({params, body}) => {
      return articleAdminRoutesPostUploadPdf({params, body})
    },
    {params: t.Object({id: t.String()}), body: t.Object({pdf: t.File({type: 'application/pdf'})})},
  )
  // Convert PDF to text for an article (async - returns immediately)
  .post(
    '/api/articles/:id/convert-pdf',
    async ({params}) => {
      return articleAdminRoutesPostConvertPdf({params})
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/articles/conversion-reconvert',
    async ({body}) => {
      return articleAdminRoutesPostConversionReconvert({body})
    },
    {body: conversionReconvertBody},
  )
  .post(
    '/api/articles/:id/canonical-fulltext/rebuild',
    async ({body, params}) => {
      return articleAdminRoutesPostCanonicalFullTextRebuild({body, params})
    },
    {body: t.Optional(t.Object({figureMode: t.Optional(t.String())})), params: t.Object({id: t.String()})},
  )

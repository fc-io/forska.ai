import {Elysia, t} from 'elysia'

import {requireAdminAuth} from '../utils/authGuard.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {dataSourcesImportRoutesPostArxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostArxiv.ts'
import {dataSourcesImportRoutesPostBiorxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostBiorxiv.ts'
import {dataSourcesImportRoutesPostMedrxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostMedrxiv.ts'
import {dataSourcesImportRoutesPostOpenalex} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostOpenalex.ts'
import {dataSourcesImportRoutesPostPubmed} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts'

export const dataSourcesImportRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .post(
    '/api/datasources/import/arxiv',
    async ({body}) => {
      return await dataSourcesImportRoutesPostArxiv(body)
    },
    {body: t.Object({id: t.String()})},
  )
  .post(
    '/api/datasources/import/biorxiv',
    async ({body}) => {
      return await dataSourcesImportRoutesPostBiorxiv(body)
    },
    {body: t.Object({id: t.String()})},
  )
  .post(
    '/api/datasources/import/medrxiv',
    async ({body}) => {
      return await dataSourcesImportRoutesPostMedrxiv(body)
    },
    {body: t.Object({id: t.String()})},
  )
  .post(
    '/api/datasources/import/pubmed',
    async ({body}) => {
      return await dataSourcesImportRoutesPostPubmed(body)
    },
    {body: t.Object({id: t.String()})},
  )
  .post(
    '/api/datasources/import/openalex',
    async ({body}) => {
      return await dataSourcesImportRoutesPostOpenalex(body)
    },
    {body: t.Object({id: t.String()})},
  )

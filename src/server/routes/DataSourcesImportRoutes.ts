import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {dataSourcesImportRoutesPostArxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostArxiv.ts'
import {dataSourcesImportRoutesPostPubmed} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts'
import {dataSourcesImportRoutesPostOpenalex} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostOpenalex.ts'

export const dataSourcesImportRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/datasources/import/arxiv',
    async ({body}) => {
      return await dataSourcesImportRoutesPostArxiv(body)
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

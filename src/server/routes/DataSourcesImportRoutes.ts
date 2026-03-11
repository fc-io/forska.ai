import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {dataSourcesImportRoutesPostArxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostArxiv.ts'
import {dataSourcesImportRoutesPostBiorxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostBiorxiv.ts'
import {dataSourcesImportRoutesPostEuropePmcPpr} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostEuropePmcPpr.ts'
import {dataSourcesImportRoutesPostFhirEhrPatients} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts'
import {dataSourcesImportRoutesPostMedrxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostMedrxiv.ts'
import {dataSourcesImportRoutesPostOpenalex} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostOpenalex.ts'
import {dataSourcesImportRoutesPostPubmed} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts'

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
    '/api/datasources/import/europe-pmc-ppr',
    async ({body}) => {
      return await dataSourcesImportRoutesPostEuropePmcPpr(body)
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
  .post(
    '/api/datasources/import/fhir-ehr-patients',
    async ({body, set}) => {
      return await dataSourcesImportRoutesPostFhirEhrPatients({body, set})
    },
    {body: t.Object({id: t.String()})},
  )

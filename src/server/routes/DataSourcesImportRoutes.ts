import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {dataSourcesImportRoutesPostArxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostArxiv.ts'
import {dataSourcesImportRoutesPostBiorxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostBiorxiv.ts'
import {dataSourcesImportRoutesPostCovidenceAnalyze} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceAnalyze.ts'
import {dataSourcesImportRoutesPostEuropePmcPpr} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostEuropePmcPpr.ts'
import {dataSourcesImportRoutesPostFhirEhrPatients} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts'
import {dataSourcesImportRoutesPostMedrxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostMedrxiv.ts'
import {dataSourcesImportRoutesPostPubmed} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts'
import {dataSourcesImportRoutesPostStructuredFile} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.ts'
import {dataSourcesImportRoutesPostStructuredFileAnalyze} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileAnalyze.ts'
import {dataSourcesImportRoutesPostStructuredFileCreate} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts'

export const dataSourcesImportRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/datasources/import/covidence-analyze',
    async ({body, set}) => {
      return await dataSourcesImportRoutesPostCovidenceAnalyze({body, set})
    },
    {
      body: t.Object({
        mode: t.Union([t.Literal('title_abstract'), t.Literal('full_text')]),
        files: t.Array(
          t.Object({
            file: t.File(),
            fileRole: t.Union([
              t.Literal('all'),
              t.Literal('irrelevant'),
              t.Literal('full_text'),
              t.Literal('excluded'),
              t.Literal('included'),
            ]),
          }),
        ),
      }),
    },
  )
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
    '/api/datasources/import/fhir-ehr-patients',
    async ({body, set}) => {
      return await dataSourcesImportRoutesPostFhirEhrPatients({body, set})
    },
    {body: t.Object({id: t.String()})},
  )
  .post(
    '/api/datasources/import/structured-file-analyze',
    async ({body, set}) => {
      return await dataSourcesImportRoutesPostStructuredFileAnalyze({body, set})
    },
    {body: t.Object({file: t.File()})},
  )
  .post(
    '/api/datasources/import/structured-file-create',
    async ({body}) => {
      return await dataSourcesImportRoutesPostStructuredFileCreate(body)
    },
    {
      body: t.Object({
        title: t.String(),
        description: t.Optional(t.String()),
        assetPath: t.String(),
        sourceFileName: t.String(),
        format: t.Union([t.Literal('json'), t.Literal('xml')]),
        boundaryPointer: t.String(),
        boundaryDisplayPath: t.String(),
      }),
    },
  )
  .post(
    '/api/datasources/import/structured-file',
    async ({body, set}) => {
      return await dataSourcesImportRoutesPostStructuredFile({body, set})
    },
    {body: t.Object({id: t.String()})},
  )

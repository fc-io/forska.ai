import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {dataSourcesImportRoutesPostArxiv} from './DataSourcesImportRoutes/dataSourcesImportRoutesPostArxiv.ts'

export const dataSourcesImportRoutes = new Elysia().use(withErrorHandler()).post(
  '/api/datasources/import/arxiv',
  async ({body}) => {
    return await dataSourcesImportRoutesPostArxiv(body)
  },
  {body: t.Object({id: t.String()})},
)

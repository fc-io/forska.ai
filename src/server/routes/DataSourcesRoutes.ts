import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {dataSourcesRoutesDeleteDataSource} from './DataSourcesRoutes/dataSourcesRoutesDeleteDataSource.ts'
import {dataSourcesRoutesGetArchived} from './DataSourcesRoutes/dataSourcesRoutesGetArchived.ts'
import {dataSourcesRoutesGetDataSource} from './DataSourcesRoutes/dataSourcesRoutesGetDataSource.ts'
import {dataSourcesRoutesGetDataSources} from './DataSourcesRoutes/dataSourcesRoutesGetDataSources.ts'
import {dataSourcesRoutesGetTrackingChanges} from './DataSourcesRoutes/dataSourcesRoutesGetTrackingChanges.ts'
import {dataSourcesRoutesPatchDataSource} from './DataSourcesRoutes/dataSourcesRoutesPatchDataSource.ts'
import {dataSourcesRoutesPostDataSource} from './DataSourcesRoutes/dataSourcesRoutesPostDataSource.ts'
import {dataSourcesRoutesPostTrackingReconcile} from './DataSourcesRoutes/dataSourcesRoutesPostTrackingReconcile.ts'

export {setDataSourceTrackingSpoolRepositoryForTests} from './DataSourcesRoutes/dataSourcesRoutesPatchDataSource/dataSourceTrackingSpoolRepositoryForRoute.ts'

export const dataSourcesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/datasources', async () => {
    return dataSourcesRoutesGetDataSources()
  })
  .get('/api/datasources/archived', async () => {
    return dataSourcesRoutesGetArchived()
  })
  .get('/api/datasources/:id', async ({params}) => {
    return dataSourcesRoutesGetDataSource({params})
  })
  .post(
    '/api/datasources',
    async ({body}) => {
      return dataSourcesRoutesPostDataSource({body})
    },
    {
      body: t.Object({
        title: t.String(),
        description: t.Optional(t.String()),
        importRoute: t.Optional(t.String()),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        trackingEnabled: t.Optional(t.Boolean()),
        trackingReconcileScheduleMonths: t.Optional(t.Array(t.Number())),
      }),
    },
  )
  .patch(
    '/api/datasources/:id',
    async ({params, body}) => {
      return dataSourcesRoutesPatchDataSource({params, body})
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        importRoute: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        trackingEnabled: t.Optional(t.Boolean()),
        trackingReconcileScheduleMonths: t.Optional(t.Array(t.Number())),
        archived: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/api/datasources/:id/tracking/reconcile', async ({params}) => {
    return dataSourcesRoutesPostTrackingReconcile({params})
  })
  .get(
    '/api/datasources/:id/tracking/changes',
    async ({params, query}) => {
      return dataSourcesRoutesGetTrackingChanges({params, query})
    },
    {
      query: t.Object({
        after: t.Optional(t.String()),
        changeKind: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        runKind: t.Optional(t.String()),
      }),
    },
  )
  .delete('/api/datasources/:id', async ({params}) => {
    return dataSourcesRoutesDeleteDataSource({params})
  })

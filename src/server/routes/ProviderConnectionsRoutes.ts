import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {providerConnectionsRoutesDeleteConnection} from './providerConnectionsRoutes/providerConnectionsRoutesDeleteConnection.ts'
import {providerConnectionsRoutesGetConnections} from './providerConnectionsRoutes/providerConnectionsRoutesGetConnections.ts'
import {providerConnectionsRoutesGetDiscoveredModels} from './providerConnectionsRoutes/providerConnectionsRoutesGetDiscoveredModels.ts'
import {providerConnectionsRoutesPatchConnection} from './providerConnectionsRoutes/providerConnectionsRoutesPatchConnection.ts'
import {providerConnectionsRoutesPostAuthBegin} from './providerConnectionsRoutes/providerConnectionsRoutesPostAuthBegin.ts'
import {providerConnectionsRoutesPostAuthFinish} from './providerConnectionsRoutes/providerConnectionsRoutesPostAuthFinish.ts'
import {providerConnectionsRoutesPostConnection} from './providerConnectionsRoutes/providerConnectionsRoutesPostConnection.ts'
import {providerConnectionsRoutesPostConnectionTest} from './providerConnectionsRoutes/providerConnectionsRoutesPostConnectionTest.ts'

export const providerConnectionsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/provider-auth/:providerKind/begin',
    async ({body, params, set}) => {
      return providerConnectionsRoutesPostAuthBegin({body, params, set})
    },
    {body: t.Object({connectionId: t.Optional(t.String())}), params: t.Object({providerKind: t.String()})},
  )
  .post(
    '/api/provider-auth/:providerKind/finish',
    async ({body, params, set}) => {
      return providerConnectionsRoutesPostAuthFinish({body, params, set})
    },
    {
      body: t.Object({connectionId: t.Optional(t.String()), payload: t.Optional(t.Any())}),
      params: t.Object({providerKind: t.String()}),
    },
  )
  .get('/api/provider-connections', async () => {
    return providerConnectionsRoutesGetConnections()
  })
  .post(
    '/api/provider-connections',
    async ({body, set}) => {
      return providerConnectionsRoutesPostConnection({body, set})
    },
    {
      body: t.Object({
        apiKey: t.Optional(t.String()),
        baseURL: t.Optional(t.Union([t.String(), t.Null()])),
        label: t.Optional(t.String()),
        llamaCppMode: t.Optional(t.Union([t.Literal('cli'), t.Literal('server')])),
        manualWorkerUrls: t.Optional(t.Array(t.String())),
        maxInflightRequests: t.Optional(t.Union([t.Number(), t.Null()])),
        providerKind: t.String(),
        workerUrls: t.Optional(t.Array(t.String())),
        workerUrlMode: t.Optional(t.Union([t.Literal('manual'), t.Literal('runtime')])),
      }),
    },
  )
  .patch(
    '/api/provider-connections/:id',
    async ({body, params, set}) => {
      return providerConnectionsRoutesPatchConnection({body, params, set})
    },
    {
      body: t.Object({
        apiKey: t.Optional(t.String()),
        baseURL: t.Optional(t.Union([t.String(), t.Null()])),
        clearSecret: t.Optional(t.Boolean()),
        enabled: t.Optional(t.Boolean()),
        label: t.Optional(t.String()),
        llamaCppMode: t.Optional(t.Union([t.Literal('cli'), t.Literal('server')])),
        manualWorkerUrls: t.Optional(t.Array(t.String())),
        maxInflightRequests: t.Optional(t.Union([t.Number(), t.Null()])),
        workerUrls: t.Optional(t.Array(t.String())),
        workerUrlMode: t.Optional(t.Union([t.Literal('manual'), t.Literal('runtime')])),
      }),
      params: t.Object({id: t.String()}),
    },
  )
  .delete(
    '/api/provider-connections/:id',
    async ({params, set}) => {
      return providerConnectionsRoutesDeleteConnection({params, set})
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/provider-connections/:id/test',
    async ({params, set}) => {
      return providerConnectionsRoutesPostConnectionTest({params, set})
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/provider-connections/:id/discovered-models',
    async ({params, set}) => {
      return providerConnectionsRoutesGetDiscoveredModels({params, set})
    },
    {params: t.Object({id: t.String()})},
  )

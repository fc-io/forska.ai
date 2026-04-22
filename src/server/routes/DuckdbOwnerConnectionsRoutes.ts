import {Elysia, t} from 'elysia'

import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
import {
  assertDuckdbOwnerConnectionHeartbeatCompatible,
  getDuckdbOwnerConnectionsOverview,
  recordDuckdbOwnerConnectionProxy,
  upsertDuckdbOwnerConnectionHeartbeat,
} from '../utils/duckdbOwnerConnections.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {runtimeReadyPath} from '../utils/runtimeReadyContract.ts'

const duckdbOwnerConnectionHeartbeatBody = t.Object({
  apiServerPort: t.Number(),
  hostname: t.String(),
  instanceId: t.Optional(t.String()),
  listenPort: t.Optional(t.Number()),
  pid: t.Number(),
  processStartedAt: t.Optional(t.String()),
  runtimeProfile: t.Optional(t.Union([t.Literal('local'), t.Literal('primary'), t.Literal('secondary')])),
  runtimeVersion: t.Optional(t.String()),
  serverRole: t.Union([
    t.Literal('api'),
    t.Literal('maintenance-worker'),
    t.Literal('judge-worker'),
    t.Literal('auto'),
    t.Literal('dev-single'),
  ]),
  service: t.Optional(
    t.Union([
      t.Literal('api-server'),
      t.Literal('app-server'),
      t.Literal('dev-single-server'),
      t.Literal('judge-worker-server'),
      t.Literal('maintenance-worker-server'),
      t.Literal('single-server'),
    ]),
  ),
  startedAt: t.String(),
  duckdbOwnerUrl: t.Nullable(t.String()),
})

export const duckdbOwnerConnectionsRoutes = new Elysia()
  .use(withErrorHandler())
  .onRequest(({request}) => {
    const pathname = new URL(request.url).pathname

    if (pathname !== runtimeReadyPath) {
      recordDuckdbOwnerConnectionProxy(request.headers, pathname)
    }
  })
  .get('/api/duckdb_owner_connections', async () => {
    return {
      data: {
        ...(await getDuckdbOwnerConnectionsOverview()),
        martRefresh: {
          ...getDuckdbMartRefreshService().getDebugSnapshot(),
          progress: getDuckdbMartRefreshService().getProgressSnapshot(),
          throughput: getDuckdbMartRefreshService().getThroughputSnapshot(),
        },
      },
    }
  })
  .post(
    '/api/duckdb_owner_connections/heartbeat',
    ({body}) => {
      assertDuckdbOwnerConnectionHeartbeatCompatible(body)
      return {data: upsertDuckdbOwnerConnectionHeartbeat(body)}
    },
    {body: duckdbOwnerConnectionHeartbeatBody},
  )

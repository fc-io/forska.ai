import {Elysia, t} from 'elysia'

import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {
  getWriterConnectionsOverview,
  recordWriterConnectionProxy,
  upsertWriterConnectionHeartbeat,
} from '../utils/writerConnections.ts'

const writerConnectionHeartbeatBody = t.Object({
  apiServerPort: t.Number(),
  hostname: t.String(),
  instanceId: t.Optional(t.String()),
  listenPort: t.Optional(t.Number()),
  pid: t.Number(),
  processStartedAt: t.Optional(t.String()),
  runtimeProfile: t.Optional(t.Union([t.Literal('local'), t.Literal('primary'), t.Literal('secondary')])),
  serverRole: t.Union([t.Literal('writer'), t.Literal('api'), t.Literal('worker'), t.Literal('dev-single')]),
  service: t.Optional(
    t.Union([
      t.Literal('api-server'),
      t.Literal('app-server'),
      t.Literal('dev-single-server'),
      t.Literal('single-server'),
      t.Literal('worker-server'),
    ]),
  ),
  startedAt: t.String(),
  writerUrl: t.Nullable(t.String()),
})

export const writerConnectionsRoutes = new Elysia()
  .use(withErrorHandler())
  .onRequest(({request}) => {
    recordWriterConnectionProxy(request.headers, new URL(request.url).pathname)
  })
  .get('/api/writer_connections', async () => {
    return {
      data: {
        ...(await getWriterConnectionsOverview()),
        martRefresh: {
          ...getDuckdbMartRefreshService().getDebugSnapshot(),
          progress: getDuckdbMartRefreshService().getProgressSnapshot(),
          throughput: getDuckdbMartRefreshService().getThroughputSnapshot(),
        },
      },
    }
  })
  .post(
    '/api/writer_connections/heartbeat',
    ({body}) => {
      return {data: upsertWriterConnectionHeartbeat(body)}
    },
    {body: writerConnectionHeartbeatBody},
  )

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
  pid: t.Number(),
  serverRole: t.Union([t.Literal('writer'), t.Literal('api'), t.Literal('worker'), t.Literal('dev-single')]),
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

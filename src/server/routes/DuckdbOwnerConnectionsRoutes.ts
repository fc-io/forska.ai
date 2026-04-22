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

const duckdbOwnerConnectionCapability = t.Union([
  t.Literal('api'),
  t.Literal('duckdb-owner'),
  t.Literal('judging'),
  t.Literal('maintenance'),
  t.Literal('owner-proxy'),
])

const duckdbOwnerConnectionThroughputProfile = t.Object({
  batchSize: t.Union([t.Number(), t.Null()]),
  martRefreshDrainEligible: t.Boolean(),
  maxCyclesPerWake: t.Union([t.Number(), t.Null()]),
  pollIntervalMs: t.Union([t.Number(), t.Null()]),
  profile: t.Union([
    t.Literal('maintenance'),
    t.Literal('maintenance-paused-low-memory'),
    t.Literal('non-maintenance'),
  ]),
})

const duckdbOwnerConnectionTakeover = t.Object({
  candidate: t.Boolean(),
  intent: t.Union([t.Literal('none'), t.Literal('standby'), t.Literal('takeover_in_progress')]),
  observedAt: t.String(),
  ownerFreshness: t.Union([
    t.Literal('owner_dead'),
    t.Literal('owner_fresh'),
    t.Literal('owner_missing'),
    t.Literal('owner_stale'),
    t.Literal('owner_unknown'),
  ]),
  ownerHeartbeatAt: t.Union([t.String(), t.Null()]),
  ownerLeaseId: t.Union([t.String(), t.Null()]),
  ownerUrl: t.Union([t.String(), t.Null()]),
})

const duckdbOwnerConnectionHeartbeatBody = t.Object({
  apiServerPort: t.Number(),
  capabilities: t.Optional(t.Array(duckdbOwnerConnectionCapability)),
  hostname: t.String(),
  instanceId: t.Optional(t.String()),
  listenPort: t.Optional(t.Number()),
  memoryLimit: t.Optional(t.Union([t.String(), t.Null()])),
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
  throughputProfile: t.Optional(t.Union([duckdbOwnerConnectionThroughputProfile, t.Null()])),
  takeover: t.Optional(t.Union([duckdbOwnerConnectionTakeover, t.Null()])),
  duckdbOwnerUrl: t.Nullable(t.String()),
})

export const duckdbOwnerConnectionsRoutes = new Elysia()
  .use(withErrorHandler())
  .onRequest(async ({request}) => {
    const pathname = new URL(request.url).pathname

    if (pathname !== runtimeReadyPath) {
      await recordDuckdbOwnerConnectionProxy(request.headers, pathname)
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
    async ({body}) => {
      assertDuckdbOwnerConnectionHeartbeatCompatible(body)
      return {data: await upsertDuckdbOwnerConnectionHeartbeat(body)}
    },
    {body: duckdbOwnerConnectionHeartbeatBody},
  )

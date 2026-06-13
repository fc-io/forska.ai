import {expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {runtimePrivateApiPrefix} from '../utils/runtimePrivateApi.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'
import {
  exposeLocalOperatorApiEnvVar,
  getPublicRouteSurfaceGateDecision,
  publicRouteSurfaceGate,
} from './publicRouteSurfaceGate.ts'

const getResponse = (path: string, method = 'GET', headers?: HeadersInit) => {
  const app = new Elysia()
    .use(publicRouteSurfaceGate)
    .all('/api/*', () => {
      return {data: 'public-route'}
    })
    .all(`${duckdbOwnerPrivateApiPrefix}/api/*`, () => {
      return {data: 'owner-private-route'}
    })
    .all(`${runtimePrivateApiPrefix}/api/*`, () => {
      return {data: 'runtime-private-route'}
    })

  return app.handle(new Request(`http://localhost${path}`, {headers, method}))
}

test('public gate blocks admin debug routes by default', async () => {
  const response = await getResponse('/api/admin/duckdb-append-metrics')
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(404)
  expect(body.error).toBe('Route is not available on the public local API surface')
})

test('public gate blocks public judgment dispatch telemetry by default', async () => {
  const response = await getResponse('/api/admin/judgment-dispatch-runtime/job-a')

  expect(response.status).toBe(404)
})

test('public gate blocks database snapshot routes by default', async () => {
  const response = await getResponse('/api/duckdbStudioSnapshots', 'POST')

  expect(response.status).toBe(404)
})

test('public gate leaves read-only Settings diagnostics routes available', async () => {
  const responses = await Promise.all([
    getResponse('/api/runtime/state'),
    getResponse('/api/admin/maintenance-runtime-diagnostics'),
    getResponse('/api/admin/worker-runtime-diagnostics'),
  ])

  expect(
    responses.map((response) => {
      return response.status
    }),
  ).toEqual([200, 200, 200])
})

test('public gate blocks internal runtime routes by default', async () => {
  const response = await getResponse('/api/provideradmissionleases/acquire', 'POST')

  expect(response.status).toBe(404)
})

test('public gate blocks spoofed peer headers on internal runtime routes', async () => {
  const response = await getResponse('/api/provideradmissionleases/acquire', 'POST', {
    'x-forska-api-server-port': '4010',
    'x-forska-runtime-version': 'split-runtime-v1',
    'x-forska-server-role': 'api',
  })

  expect(response.status).toBe(404)
})

test('public gate allows duckdb owner connection heartbeats', () => {
  const decision = getPublicRouteSurfaceGateDecision({
    method: 'POST',
    pathname: '/api/duckdb_owner_connections/heartbeat',
  })

  expect(decision.shouldGate).toBe(false)
})

test('public gate leaves backend readiness routes available', async () => {
  const response = await getResponse('/api/runtime/ready')

  expect(response.status).toBe(200)
})

test('public gate leaves supported and sensitive product routes available', async () => {
  const usersResponse = await getResponse('/api/users')
  const projectResponse = await getResponse('/api/projects/project-1/export', 'POST')

  expect(usersResponse.status).toBe(200)
  expect(projectResponse.status).toBe(200)
})

test('public gate leaves UI-required status routes available', async () => {
  const responses = await Promise.all([
    getResponse('/api/duckdb_owner_connections'),
    getResponse('/api/judgmentsjobs-provider-telemetry-history'),
    getResponse('/api/projectsreviewswarnings', 'POST'),
    getResponse('/api/judgmentsjobs'),
    getResponse('/api/judgmentsjobs/job-1'),
    getResponse('/api/llmstatus'),
    getResponse('/api/tokens'),
    getResponse('/api/tokens/timelineAllJobs', 'POST'),
    getResponse('/api/tokens/timelineAllJobsStats', 'POST'),
  ])

  expect(
    responses.map((response) => {
      return response.status
    }),
  ).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200])
})

test('public gate leaves owner-private RPC available for split-runtime internals', async () => {
  const response = await getResponse(`${duckdbOwnerPrivateApiPrefix}/api/duckdbStudioSnapshots`, 'POST')
  const body = (await response.json()) as {data: string}

  expect(response.status).toBe(200)
  expect(body.data).toBe('owner-private-route')
})

test('public gate leaves runtime-private RPC available for split-runtime internals', async () => {
  const response = await getResponse(`${runtimePrivateApiPrefix}/api/admin/judgment-dispatch-runtime/job-a`)
  const body = (await response.json()) as {data: string}

  expect(response.status).toBe(200)
  expect(body.data).toBe('runtime-private-route')
})

test('public gate can expose local operator routes when explicitly enabled', () => {
  const decision = getPublicRouteSurfaceGateDecision({
    envValues: {[exposeLocalOperatorApiEnvVar]: 'true'},
    method: 'GET',
    pathname: '/api/admin/duckdb-append-metrics',
  })

  expect(decision.shouldGate).toBe(false)
})

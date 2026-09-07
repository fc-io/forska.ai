import {expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {runtimePrivateApiPrefix} from '../utils/runtimePrivateApi.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'
import {getPublicRouteSurfaceGateDecision, publicRouteSurfaceGate} from './publicRouteSurfaceGate.ts'

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

test('public gate allows local diagnostics without operator mode', async () => {
  const response = await getResponse('/api/admin/duckdb-append-metrics')
  const body = (await response.json()) as {data: string}

  expect(response.status).toBe(200)
  expect(body.data).toBe('public-route')
})

test('public gate allows local judgment dispatch telemetry', async () => {
  const response = await getResponse('/api/admin/judgment-dispatch-runtime/job-a')

  expect(response.status).toBe(200)
})

test('public gate allows local database snapshot controls', async () => {
  const response = await getResponse('/api/duckdbStudioSnapshots', 'POST')

  expect(response.status).toBe(200)
})

test('public gate leaves failed PDF conversion status and reset available to the local app', async () => {
  const responses = await Promise.all([
    getResponse('/api/articles/conversion-stats'),
    getResponse('/api/articles/conversion-reset', 'POST'),
  ])

  expect(
    responses.map((response) => {
      return response.status
    }),
  ).toEqual([200, 200])
})

test('public gate allows the PDF fetch reset control', async () => {
  const response = await getResponse('/api/articles/pdf-fetch-reset', 'POST')

  expect(response.status).toBe(200)
})

test.each([
  ['GET', '/api/nvidiasmi'],
  ['GET', '/api/models/gpu-info'],
  ['GET', '/api/admin/list-prompts-with-types'],
  ['GET', '/api/admin/investigate-unexpected-answers'],
  ['POST', '/api/admin/delete-unexpected-answers'],
  ['GET', '/api/prompts/duplicates'],
  ['GET', '/api/prompts/orphans'],
  ['GET', '/api/prompts/invalid-judgments'],
  ['POST', '/api/prompts/merge'],
  ['DELETE', '/api/prompts/prompt-1'],
  ['GET', '/api/judgmentsjobs-health'],
  ['GET', '/api/judgmentsjobs/job-1/health'],
  ['POST', '/api/judgmentsjobs/job-1/start-clean'],
  ['POST', '/api/judgmentsjobs/job-1/preflight'],
  ['POST', '/api/judgmentsjobs/job-1/repair'],
  ['POST', '/api/judgmentsjobs/job-1/drain'],
  ['POST', '/api/judgmentsjobs/job-1/checkpoint'],
  ['POST', '/api/judgmentsjobs/job-1/quarantine'],
  ['POST', '/api/judgmentsjobs/job-1/unquarantine'],
  ['POST', '/api/judgmentsjobs/job-1/repair-orphaned-queue'],
  ['POST', '/api/projects/delete-archived'],
])('local app control %s %s is available without operator mode', async (method, path) => {
  const response = await getResponse(path, method)

  expect(response.status).toBe(200)
})

test('public gate keeps the unreleased FHIR importer blocked', async () => {
  const response = await getResponse('/api/datasources/import/fhir-ehr-patients', 'POST')

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
  const clearDatabasesResponse = await getResponse('/api/admin/clear-databases', 'POST')

  expect(usersResponse.status).toBe(200)
  expect(projectResponse.status).toBe(200)
  expect(clearDatabasesResponse.status).toBe(200)
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

test.each([
  ['POST', '/api/provideradmissionleases/acquire'],
  ['POST', '/api/judgmentsjobs/job-1/claim'],
  ['POST', '/api/judgmentsjobs/job-1/complete'],
  ['GET', '/api/judgmentsjobs/job-1/runtime'],
])('retired operator setting cannot expose internal route %s %s', async (method, path) => {
  const previousValue = process.env.FORSKA_EXPOSE_LOCAL_OPERATOR_API

  try {
    process.env.FORSKA_EXPOSE_LOCAL_OPERATOR_API = 'true'
    const response = await getResponse(path, method)

    expect(response.status).toBe(404)
  } finally {
    if (previousValue === undefined) {
      delete process.env.FORSKA_EXPOSE_LOCAL_OPERATOR_API
    } else {
      process.env.FORSKA_EXPOSE_LOCAL_OPERATOR_API = previousValue
    }
  }
})

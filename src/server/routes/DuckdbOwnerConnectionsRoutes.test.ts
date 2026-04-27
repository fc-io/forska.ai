import {expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const duckdbOwnerConnectionsModulePath = new URL('../utils/duckdbOwnerConnections.ts', import.meta.url).pathname
const martRefreshServiceModulePath = new URL('../services/getDuckdbMartRefreshService.ts', import.meta.url).pathname

void mock.module(duckdbOwnerConnectionsModulePath, () => {
  return {
    assertDuckdbOwnerConnectionHeartbeatCompatible: () => {},
    getDuckdbOwnerConnectionsOverview: async () => {
      return {
        followers: [],
        history: [],
        owner: null,
        registry: {
          capabilities: [],
          freshRegisteredProcessCount: 0,
          registeredProcessCount: 0,
          staleRegisteredProcessCount: 0,
          takeover: {
            candidateCount: 0,
            latestObservedAt: null,
            latestOwnerFreshness: 'owner_unknown',
            status: 'unknown',
            takeoverInProgressCount: 0,
          },
        },
        runtimeVersion: 'split-runtime-v1',
        warnings: [],
      }
    },
    recordDuckdbOwnerConnectionProxy: async () => {
      throw new Error('worker registry write failed')
    },
    upsertDuckdbOwnerConnectionHeartbeat: async (body: unknown) => {
      return body
    },
  }
})

void mock.module(martRefreshServiceModulePath, () => {
  return {
    getDuckdbMartRefreshService: () => {
      return {
        getDebugSnapshot: () => {
          return {}
        },
        getProgressSnapshot: () => {
          return {}
        },
        getThroughputSnapshot: () => {
          return {}
        },
      }
    },
  }
})

test('DuckDB owner connection proxy recording failures do not fail unrelated API routes', async () => {
  const {duckdbOwnerConnectionsRoutes} = (await import(
    `./DuckdbOwnerConnectionsRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./DuckdbOwnerConnectionsRoutes.ts')
  const app = new Elysia().use(duckdbOwnerConnectionsRoutes).get('/api/projects', () => {
    return {data: [{id: 'project-1', name: 'Project 1'}], error: null}
  })

  const response = await app.handle(new Request('http://localhost/api/projects'))
  const body = (await response.json()) as {data: Array<{id: string; name: string}>; error: string | null}

  expect(response.status).toBe(200)
  expect(body.error).toBeNull()
  expect(body.data).toEqual([{id: 'project-1', name: 'Project 1'}])
})

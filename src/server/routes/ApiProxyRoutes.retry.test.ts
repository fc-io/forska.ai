import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const envModulePath = new URL('../utils/env.ts', import.meta.url).pathname
const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).pathname
const duckdbOwnerConnectionsModulePath = new URL('../utils/duckdbOwnerConnections.ts', import.meta.url).pathname
type EnvModule = typeof import('../utils/env.ts')
type ServerRuntimeRoleModule = typeof import('../utils/serverRuntimeRole.ts')
type DuckdbOwnerConnectionsModule = typeof import('../utils/duckdbOwnerConnections.ts')
const actualEnvModule = (await import(`${envModulePath}?actual=${Date.now()}`)) as EnvModule
const actualServerRuntimeRoleModule = (await import(
  `${serverRuntimeRoleModulePath}?actual=${Date.now()}`
)) as ServerRuntimeRoleModule
const actualDuckdbOwnerConnectionsModule = (await import(
  `${duckdbOwnerConnectionsModulePath}?actual=${Date.now()}`
)) as DuckdbOwnerConnectionsModule

const originalFetch = globalThis.fetch

const state: {ownerUrls: string[]; shouldProxy: boolean} = {ownerUrls: ['http://owner-1:34991'], shouldProxy: true}

const getCurrentServerDuckdbOwnerUrl = mock(async () => {
  if (state.ownerUrls.length === 0) {
    return null
  }

  const [currentOwnerUrl = '', ...remainingOwnerUrls] = state.ownerUrls
  state.ownerUrls = remainingOwnerUrls.length === 0 ? [currentOwnerUrl] : remainingOwnerUrls
  return currentOwnerUrl
})

void mock.module(envModulePath, () => {
  return {...actualEnvModule, env: {...actualEnvModule.env, API_SERVER_PORT: 34990}}
})

void mock.module(serverRuntimeRoleModulePath, () => {
  return {
    ...actualServerRuntimeRoleModule,
    getCurrentServerDuckdbOwnerUrl,
    shouldCurrentServerProxyApiToOwner: () => {
      return state.shouldProxy
    },
  }
})

void mock.module(duckdbOwnerConnectionsModulePath, () => {
  return {
    ...actualDuckdbOwnerConnectionsModule,
    getDuckdbOwnerConnectionProxyHeaders: () => {
      return {}
    },
  }
})

const loadRoutes = async () => {
  const {apiProxyRoutes} = await import('./ApiProxyRoutes.ts')

  return new Elysia().use(apiProxyRoutes)
}

afterEach(() => {
  getCurrentServerDuckdbOwnerUrl.mockClear()
  state.shouldProxy = true
  state.ownerUrls = ['http://owner-1:34991']
  globalThis.fetch = originalFetch
})

test('api proxy retries idempotent GET requests after a transport failure', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url

    if (url.startsWith('http://owner-1:34991')) {
      throw new Error('owner-1 unavailable')
    }

    return Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991', 'http://owner-2:34992']

  const response = await app.handle(new Request('http://localhost/api/example?x=1', {method: 'GET'}))
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('api proxy does not retry non-idempotent POST requests after a transport failure', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (_request: Request | URL | string) => {
    throw new Error('owner unavailable')
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991', 'http://owner-2:34992']

  const response = await app.handle(
    new Request('http://localhost/api/example', {
      body: JSON.stringify({hello: 'world'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(502)
  expect(body.error).toContain('DuckDB owner proxy target unavailable')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('api proxy retries idempotent DELETE requests after a temporary same-owner transport failure', async () => {
  const app = await loadRoutes()
  let shouldFail = true
  const fetchMock = mock(async (_request: Request | URL | string) => {
    if (shouldFail) {
      shouldFail = false
      throw new Error('owner unavailable')
    }

    return Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991']

  const response = await app.handle(new Request('http://localhost/api/example', {method: 'DELETE'}))
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const envModulePath = new URL('../utils/env.ts', import.meta.url).pathname
const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).pathname
const writerConnectionsModulePath = new URL('../utils/writerConnections.ts', import.meta.url).pathname
type EnvModule = typeof import('../utils/env.ts')
type ServerRuntimeRoleModule = typeof import('../utils/serverRuntimeRole.ts')
type WriterConnectionsModule = typeof import('../utils/writerConnections.ts')
const actualEnvModule = (await import(`${envModulePath}?actual=${Date.now()}`)) as EnvModule
const actualServerRuntimeRoleModule = (await import(
  `${serverRuntimeRoleModulePath}?actual=${Date.now()}`
)) as ServerRuntimeRoleModule
const actualWriterConnectionsModule = (await import(
  `${writerConnectionsModulePath}?actual=${Date.now()}`
)) as WriterConnectionsModule

const originalFetch = globalThis.fetch

const state: {shouldProxy: boolean; writerUrls: string[]} = {shouldProxy: true, writerUrls: ['http://writer-1:34991']}

const getCurrentServerWriterUrl = mock(async () => {
  if (state.writerUrls.length === 0) {
    return null
  }

  const [currentWriterUrl = '', ...remainingWriterUrls] = state.writerUrls
  state.writerUrls = remainingWriterUrls.length === 0 ? [currentWriterUrl] : remainingWriterUrls
  return currentWriterUrl
})

void mock.module(envModulePath, () => {
  return {...actualEnvModule, env: {...actualEnvModule.env, API_SERVER_PORT: 34990}}
})

void mock.module(serverRuntimeRoleModulePath, () => {
  return {
    ...actualServerRuntimeRoleModule,
    getCurrentServerWriterUrl,
    shouldCurrentServerProxyApiToWriter: () => {
      return state.shouldProxy
    },
  }
})

void mock.module(writerConnectionsModulePath, () => {
  return {
    ...actualWriterConnectionsModule,
    getWriterConnectionProxyHeaders: () => {
      return {}
    },
  }
})

const loadRoutes = async () => {
  const {apiProxyRoutes} = await import('./ApiProxyRoutes.ts')

  return new Elysia().use(apiProxyRoutes)
}

afterEach(() => {
  getCurrentServerWriterUrl.mockClear()
  state.shouldProxy = true
  state.writerUrls = ['http://writer-1:34991']
  globalThis.fetch = originalFetch
})

test('api proxy retries idempotent GET requests after a transport failure', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url

    if (url.startsWith('http://writer-1:34991')) {
      throw new Error('writer-1 unavailable')
    }

    return Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.writerUrls = ['http://writer-1:34991', 'http://writer-2:34992']

  const response = await app.handle(new Request('http://localhost/api/example?x=1', {method: 'GET'}))
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('api proxy does not retry non-idempotent POST requests after a transport failure', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (_request: Request | URL | string) => {
    throw new Error('writer unavailable')
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.writerUrls = ['http://writer-1:34991', 'http://writer-2:34992']

  const response = await app.handle(
    new Request('http://localhost/api/example', {
      body: JSON.stringify({hello: 'world'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(502)
  expect(body.error).toContain('Writer proxy target unavailable')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('api proxy retries idempotent DELETE requests after a temporary same-writer transport failure', async () => {
  const app = await loadRoutes()
  let shouldFail = true
  const fetchMock = mock(async (_request: Request | URL | string) => {
    if (shouldFail) {
      shouldFail = false
      throw new Error('writer unavailable')
    }

    return Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.writerUrls = ['http://writer-1:34991']

  const response = await app.handle(new Request('http://localhost/api/example', {method: 'DELETE'}))
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

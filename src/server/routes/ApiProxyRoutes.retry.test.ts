import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const envModulePath = new URL('../utils/env.ts', import.meta.url).pathname
const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).pathname
const duckdbOwnerConnectionsModulePath = new URL('../utils/duckdbOwnerConnections.ts', import.meta.url).pathname
const runtimeCutoverModulePath = new URL('../utils/runtimeCutover.ts', import.meta.url).pathname
type EnvModule = typeof import('../utils/env.ts')
type ServerRuntimeRoleModule = typeof import('../utils/serverRuntimeRole.ts')
type DuckdbOwnerConnectionsModule = typeof import('../utils/duckdbOwnerConnections.ts')
type RuntimeCutoverModule = typeof import('../utils/runtimeCutover.ts')
const actualEnvModule = (await import(`${envModulePath}?actual=${Date.now()}`)) as EnvModule
const actualServerRuntimeRoleModule = (await import(
  `${serverRuntimeRoleModulePath}?actual=${Date.now()}`
)) as ServerRuntimeRoleModule
const actualDuckdbOwnerConnectionsModule = (await import(
  `${duckdbOwnerConnectionsModulePath}?actual=${Date.now()}`
)) as DuckdbOwnerConnectionsModule
const actualRuntimeCutoverModule = (await import(
  `${runtimeCutoverModulePath}?actual=${Date.now()}`
)) as RuntimeCutoverModule

const originalFetch = globalThis.fetch
const textEncoder = new TextEncoder()

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

const getRequestUrl = (request: Request | URL | string) => {
  return typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
}

const isRuntimeReadyUrl = (url: string) => {
  return url.endsWith('/api/runtime/ready')
}

const getCompatibleRuntimeReadyResponse = () => {
  const runtimeVersion = actualRuntimeCutoverModule.getRuntimeCutoverVersion()

  return Response.json({data: {ready: true, runtimeVersion}})
}

const getOwnerFetchCallUrls = (calls: Array<[Request | URL | string]>) => {
  return calls
    .map(([request]) => {
      return getRequestUrl(request)
    })
    .filter((url) => {
      return url.startsWith('http://owner-')
    })
}

const getTextStream = (text: string, onPull: () => void) => {
  const streamState = {sent: false}

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull()

      if (streamState.sent) {
        controller.close()
        return
      }

      streamState.sent = true
      controller.enqueue(textEncoder.encode(text))
      controller.close()
    },
  })
}

const getStreamingUploadRequest = (params: {onPull: () => void; sessionId?: string; text?: string}) => {
  const sessionId = params.sessionId ?? 'session-1'
  const text = params.text ?? 'zip-body'

  return new Request(`http://localhost/api/projects/import/${sessionId}/upload?replace=true`, {
    body: getTextStream(text, params.onPull),
    headers: {'content-type': 'application/zip'},
    method: 'PUT',
  })
}

const getRequestCloneFailureMock = (request: Request) => {
  const cloneMock = mock(() => {
    throw new Error('streaming upload request body must not be cloned')
  })

  Object.defineProperty(request, 'clone', {value: cloneMock})

  return cloneMock
}

afterEach(() => {
  getCurrentServerDuckdbOwnerUrl.mockClear()
  state.shouldProxy = true
  state.ownerUrls = ['http://owner-1:34991']
  globalThis.fetch = originalFetch
})

test.serial('api proxy retries idempotent GET requests after a transport failure', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (url.startsWith('http://owner-1:34991')) {
      throw new Error('owner-1 unavailable')
    }

    return isRuntimeReadyUrl(url) ? getCompatibleRuntimeReadyResponse() : Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991', 'http://owner-2:34992']

  const response = await app.handle(new Request('http://localhost/api/example?x=1', {method: 'GET'}))
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(ownerFetchCallUrls).toHaveLength(4)
})

test.serial('api proxy does not retry non-idempotent POST requests after a transport failure', async () => {
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
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(502)
  expect(body.error).toContain('DuckDB owner proxy target unavailable')
  expect(ownerFetchCallUrls).toHaveLength(2)
})

test.serial('api proxy retries idempotent DELETE requests after a temporary same-owner transport failure', async () => {
  const app = await loadRoutes()
  let shouldFail = true
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

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
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(ownerFetchCallUrls).toHaveLength(4)
})

test.serial('api proxy rejects a pre-cutover DuckDB owner target before forwarding', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? Response.json({data: {owner: {apiServerPort: 34991}}})
      : Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(new Request('http://localhost/api/example', {method: 'GET'}))
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(426)
  expect(body.error).toContain('Incompatible Forska split runtime version')
  expect(ownerFetchCallUrls).toHaveLength(1)
})

test.serial('api proxy rejects pre-cutover owner-routed peer headers', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async () => {
    return Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/example', {
      headers: {'x-forska-api-server-port': '4010', 'x-forska-server-role': 'api'},
      method: 'GET',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(426)
  expect(body.error).toContain('Incompatible Forska split runtime version')
  expect(ownerFetchCallUrls).toHaveLength(0)
})

test.serial('api proxy streams project transfer uploads through the owner without buffering', async () => {
  const app = await loadRoutes()
  let uploadPullCount = 0
  const request = getStreamingUploadRequest({
    onPull: () => {
      uploadPullCount += 1
    },
  })
  const cloneMock = getRequestCloneFailureMock(request)
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    const forwardedRequest = request as Request
    const bodyText = await forwardedRequest.text()

    return Response.json({
      data: {bodyText, contentType: forwardedRequest.headers.get('content-type'), method: forwardedRequest.method, url},
      error: null,
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(request)
  const body = (await response.json()) as {
    data: {bodyText: string; contentType: string | null; method: string; url: string}
    error: string | null
  }
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(200)
  expect(body.error).toBe(null)
  expect(body.data).toEqual({
    bodyText: 'zip-body',
    contentType: 'application/zip',
    method: 'PUT',
    url: 'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/session-1/upload?replace=true',
  })
  expect(uploadPullCount).toBeGreaterThan(0)
  expect(request.bodyUsed).toBe(true)
  expect(cloneMock).toHaveBeenCalledTimes(0)
  expect(ownerFetchCallUrls).toHaveLength(2)
})

test.serial('api proxy fails no-owner project transfer uploads before consuming the body', async () => {
  const app = await loadRoutes()
  const request = getStreamingUploadRequest({onPull: () => {}})
  const cloneMock = getRequestCloneFailureMock(request)
  const fetchMock = mock(async () => {
    return Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = []

  const response = await app.handle(request)
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(502)
  expect(body.error).toContain('DuckDB owner proxy target unavailable')
  expect(request.bodyUsed).toBe(false)
  expect(cloneMock).toHaveBeenCalledTimes(0)
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test.serial('api proxy does not retry failed project transfer upload streams', async () => {
  const app = await loadRoutes()
  const request = getStreamingUploadRequest({onPull: () => {}})
  const cloneMock = getRequestCloneFailureMock(request)
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    throw new Error('owner unavailable')
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991', 'http://owner-2:34992']

  const response = await app.handle(request)
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(502)
  expect(body.error).toContain('DuckDB owner proxy target unavailable')
  expect(request.bodyUsed).toBe(false)
  expect(cloneMock).toHaveBeenCalledTimes(0)
  expect(ownerFetchCallUrls).toHaveLength(2)
})

test.serial('api proxy keeps project transfer export downloads streaming from the owner response', async () => {
  const app = await loadRoutes()
  let downloadPullCount = 0
  let ownerResponse: Response | null = null
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    ownerResponse = new Response(
      getTextStream('download-body', () => {
        downloadPullCount += 1
      }),
      {headers: {'content-type': 'application/zip'}},
    )

    return ownerResponse
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/export/export-1/download', {method: 'GET'}),
  )
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(ownerResponse?.bodyUsed ?? true).toBe(false)
  expect(await response.text()).toBe('download-body')
  expect(ownerResponse?.bodyUsed ?? false).toBe(true)
  expect(downloadPullCount).toBeGreaterThan(0)
  expect(ownerFetchCallUrls).toHaveLength(2)
})

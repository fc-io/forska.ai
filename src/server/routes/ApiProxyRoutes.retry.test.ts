import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const envModulePath = new URL('../utils/env.ts', import.meta.url).href
const serverRuntimeRoleModulePath = new URL('../utils/serverRuntimeRole.ts', import.meta.url).href
const duckdbOwnerConnectionsModulePath = new URL('../utils/duckdbOwnerConnections.ts', import.meta.url).href
const runtimeCutoverModulePath = new URL('../utils/runtimeCutover.ts', import.meta.url).href
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
const originalAbortSignalTimeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
const textEncoder = new TextEncoder()
const importArtifactTestRoot = join(process.cwd(), 'tmp/project-transfer/import/api-proxy-status-artifact-test')
const exportArtifactTestRoot = join(process.cwd(), 'tmp/project-transfer/export/api-proxy-export-artifact-test')

const state: {ownerUrls: Array<string | null>; shouldProxy: boolean} = {
  ownerUrls: ['http://owner-1:34991'],
  shouldProxy: true,
}

const getCurrentServerDuckdbOwnerUrl = mock(async () => {
  if (state.ownerUrls.length === 0) {
    return null
  }

  const [currentOwnerUrl = null, ...remainingOwnerUrls] = state.ownerUrls
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

  return Response.json({data: {duckdbOwner: true, ready: true, runtimeVersion}})
}

const getNotReadyRuntimeReadyResponse = () => {
  const runtimeVersion = actualRuntimeCutoverModule.getRuntimeCutoverVersion()

  return Response.json({data: {duckdbOwner: true, ready: false, runtimeVersion}})
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

const installFastAbortSignalTimeoutMock = () => {
  const timeoutMock = mock((timeoutMs: number) => {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort(new Error(`test timeout ${timeoutMs}`))
    }, 1)
    return controller.signal
  })

  Object.defineProperty(AbortSignal, 'timeout', {configurable: true, value: timeoutMock})
  return timeoutMock
}

const waitForForwardedRequestAbort = async (request: Request) => {
  await new Promise<never>((_resolve, reject) => {
    if (request.signal.aborted) {
      reject(new Error('owner request aborted'))
      return
    }

    request.signal.addEventListener(
      'abort',
      () => {
        reject(new Error('owner request aborted'))
      },
      {once: true},
    )
  })
}

const writeFailedImportProgressArtifact = () => {
  mkdirSync(importArtifactTestRoot, {recursive: true})
  writeFileSync(
    join(importArtifactTestRoot, 'progress.json'),
    JSON.stringify({
      message: 'Commit failed; rollback cleanup completed or was not required',
      phase: 'commit',
      rowCountProcessed: 0,
      rowCountTotal: 142_616,
      status: 'failed',
      updatedAt: '2030-01-01T00:00:00.000Z',
    }),
  )
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
  if (originalAbortSignalTimeoutDescriptor !== undefined) {
    Object.defineProperty(AbortSignal, 'timeout', originalAbortSignalTimeoutDescriptor)
  }
  rmSync(importArtifactTestRoot, {force: true, recursive: true})
  rmSync(exportArtifactTestRoot, {force: true, recursive: true})
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

test.serial(
  'api proxy waits through a DuckDB owner restart for idempotent project reads',
  async () => {
    const app = await loadRoutes()
    let readinessFailureCount = 40
    const fetchMock = mock(async (request: Request | URL | string) => {
      const url = getRequestUrl(request)

      if (url.startsWith('http://owner-1:34991') && readinessFailureCount > 0) {
        readinessFailureCount -= 1
        throw new Error('owner restarting')
      }

      return isRuntimeReadyUrl(url)
        ? getCompatibleRuntimeReadyResponse()
        : Response.json({data: {ok: true}, error: null})
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const startedAt = Date.now()
    const response = await app.handle(new Request('http://localhost/api/projects', {method: 'GET'}))
    const elapsedMs = Date.now() - startedAt
    const body = (await response.json()) as {data: {ok: boolean}; error: string | null}
    const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

    expect(response.status).toBe(200)
    expect(body.data.ok).toBe(true)
    expect(readinessFailureCount).toBe(0)
    expect(elapsedMs).toBeGreaterThanOrEqual(4_000)
    expect(ownerFetchCallUrls.at(-1)).toBe('http://owner-1:34991/__duckdb-owner-rpc/api/projects')
  },
  15_000,
)

test.serial('api proxy waits for owner-dependent comparison GET readiness before forwarding', async () => {
  const app = await loadRoutes()
  let notReadyCount = 2
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url) && notReadyCount > 0) {
      notReadyCount -= 1
      return getNotReadyRuntimeReadyResponse()
    }

    return isRuntimeReadyUrl(url) ? getCompatibleRuntimeReadyResponse() : Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(notReadyCount).toBe(0)
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1',
  ])
})

test.serial('api proxy times out wedged DuckDB owner diagnostic GET requests', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    await waitForForwardedRequestAbort(request as Request)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const startedAt = Date.now()
  const response = await app.handle(new Request('http://localhost/api/llmstatus', {method: 'GET'}))
  const elapsedMs = Date.now() - startedAt
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(504)
  expect(body.data).toBe(null)
  expect(body.error).toContain('DuckDB owner proxy target timed out')
  expect(elapsedMs).toBeLessThan(4_000)
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/llmstatus',
  ])
})

test.serial('api proxy times out wedged owner-dependent GET requests', async () => {
  const app = await loadRoutes()
  const timeoutMock = installFastAbortSignalTimeoutMock()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    await waitForForwardedRequestAbort(request as Request)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const startedAt = Date.now()
  const response = await app.handle(new Request('http://localhost/api/projects', {method: 'GET'}))
  const elapsedMs = Date.now() - startedAt
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(504)
  expect(body.data).toBe(null)
  expect(body.error).toContain('DuckDB owner proxy target timed out after 60000 ms')
  expect(elapsedMs).toBeLessThan(1_000)
  expect(timeoutMock).toHaveBeenCalledWith(60000)
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects',
  ])
})

test.serial('api proxy times out wedged non-retryable owner mutations without retrying', async () => {
  const app = await loadRoutes()
  const timeoutMock = installFastAbortSignalTimeoutMock()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    await waitForForwardedRequestAbort(request as Request)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/articlesreviews', {
      body: JSON.stringify({projectId: 'project-1'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(504)
  expect(body.data).toBe(null)
  expect(body.error).toContain('DuckDB owner proxy target timed out after 60000 ms')
  expect(timeoutMock).toHaveBeenCalledWith(60000)
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/articlesreviews',
  ])
})

test.serial(
  'api proxy serves active project import status from progress artifact before contacting owner',
  async () => {
    const app = await loadRoutes()
    mkdirSync(importArtifactTestRoot, {recursive: true})
    writeFileSync(
      join(importArtifactTestRoot, 'progress.json'),
      JSON.stringify({
        message: 'Commit app-table writes running',
        phase: 'commit',
        rowCountProcessed: 0,
        rowCountTotal: 142_616,
        status: 'running',
        updatedAt: '2030-01-01T00:00:00.000Z',
      }),
    )
    const fetchMock = mock(async () => {
      throw new Error('owner proxy should not be contacted when a running import progress artifact exists')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.handle(
      new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
    )
    const body = (await response.json()) as {
      data: {id: string; progress: {message: string; rowCountProcessed: number; rowCountTotal: number}; state: string}
      error: string | null
    }

    expect(response.status).toBe(200)
    expect(body.error).toBe(null)
    expect(body.data.id).toBe('api-proxy-status-artifact-test')
    expect(body.data.state).toBe('committing')
    expect(body.data.progress.message).toBe('Commit app-table writes running')
    expect(body.data.progress.rowCountProcessed).toBe(0)
    expect(body.data.progress.rowCountTotal).toBe(142_616)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  },
)

test.serial('api proxy falls through stale active project import status artifacts to the owner', async () => {
  const app = await loadRoutes()
  mkdirSync(importArtifactTestRoot, {recursive: true})
  writeFileSync(
    join(importArtifactTestRoot, 'progress.json'),
    JSON.stringify({
      message: 'Scanning package archive',
      phase: 'package_scan',
      status: 'running',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  )
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({data: {id: 'api-proxy-status-artifact-test', state: 'failed'}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({data: {state: 'failed'}, error: null})
  expect(getOwnerFetchCallUrls(fetchMock.mock.calls)).toContain(
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/api-proxy-status-artifact-test',
  )
})

test.serial('api proxy prefers durable owner errors over failed project import status artifacts', async () => {
  const app = await loadRoutes()
  writeFailedImportProgressArtifact()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({
          data: {
            error: {message: 'Durable DuckDB out of memory error', name: 'Error'},
            id: 'api-proxy-status-artifact-test',
            state: 'failed',
          },
          error: null,
        })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {error: unknown; state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {error: {message: 'Durable DuckDB out of memory error', name: 'Error'}, state: 'failed'},
    error: null,
  })
  expect(getOwnerFetchCallUrls(fetchMock.mock.calls)).toContain(
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/api-proxy-status-artifact-test',
  )
})

test.serial('api proxy falls back to failed import progress when the DuckDB owner is unavailable', async () => {
  const app = await loadRoutes()
  writeFailedImportProgressArtifact()
  state.ownerUrls = []
  const fetchMock = mock(async () => {
    throw new Error('owner proxy should not fetch without an owner target')
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {progress: {message: string}; state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {progress: {message: 'Commit failed; rollback cleanup completed or was not required'}, state: 'failed'},
    error: null,
  })
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test.serial('api proxy falls back to failed import progress when the DuckDB owner returns 502', async () => {
  const app = await loadRoutes()
  writeFailedImportProgressArtifact()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({data: null, error: 'DuckDB owner unavailable'}, {status: 502})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({data: {state: 'failed'}, error: null})
  expect(getOwnerFetchCallUrls(fetchMock.mock.calls)).toContain(
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/api-proxy-status-artifact-test',
  )
})

test.serial('api proxy falls back to failed import progress when the DuckDB owner returns 504', async () => {
  const app = await loadRoutes()
  writeFailedImportProgressArtifact()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({data: null, error: 'DuckDB owner timed out'}, {status: 504})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({data: {state: 'failed'}, error: null})
  expect(getOwnerFetchCallUrls(fetchMock.mock.calls)).toContain(
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/api-proxy-status-artifact-test',
  )
})

test.serial('api proxy falls back to stale active import progress when the DuckDB owner times out', async () => {
  const app = await loadRoutes()
  mkdirSync(importArtifactTestRoot, {recursive: true})
  writeFileSync(
    join(importArtifactTestRoot, 'progress.json'),
    JSON.stringify({
      message: 'Finalizing import analysis artifacts',
      phase: 'analyze',
      rowCountProcessed: 142_616,
      rowCountTotal: 142_616,
      status: 'running',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  )
  const timeoutMock = installFastAbortSignalTimeoutMock()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    await waitForForwardedRequestAbort(request as Request)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/api-proxy-status-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {data: {progress: {message: string}; state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {progress: {message: 'Finalizing import analysis artifacts'}, state: 'analyzing'},
    error: null,
  })
  expect(timeoutMock).toHaveBeenCalledWith(60000)
  expect(getOwnerFetchCallUrls(fetchMock.mock.calls)).toContain(
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/api-proxy-status-artifact-test',
  )
})

test.serial('api proxy serves project export status from progress artifact before contacting owner', async () => {
  const app = await loadRoutes()
  mkdirSync(exportArtifactTestRoot, {recursive: true})
  writeFileSync(
    join(exportArtifactTestRoot, 'progress.json'),
    JSON.stringify({
      expiresAt: '2030-01-01T00:00:00.000Z',
      phase: 'export_assembly',
      rowCountProcessed: 10,
      rowCountTotal: 123_830,
      status: 'running',
      updatedAt: '2026-08-12T15:53:00.000Z',
    }),
  )
  const fetchMock = mock(async () => {
    throw new Error('owner proxy should not be contacted when a running export progress artifact exists')
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/export/api-proxy-export-artifact-test', {method: 'GET'}),
  )
  const body = (await response.json()) as {
    data: {exportId: string; progress: {rowCountProcessed: number; rowCountTotal: number}; status: string}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body.error).toBe(null)
  expect(body.data.exportId).toBe('api-proxy-export-artifact-test')
  expect(body.data.status).toBe('assembling')
  expect(body.data.progress.rowCountProcessed).toBe(10)
  expect(body.data.progress.rowCountTotal).toBe(123_830)
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test.serial('api proxy does not retry non-idempotent POST requests after a transport failure', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    if (isRuntimeReadyUrl(getRequestUrl(request))) {
      return getCompatibleRuntimeReadyResponse()
    }

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
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/example',
  ])
})

test.serial('api proxy waits for owner readiness before forwarding a non-idempotent PATCH once', async () => {
  const app = await loadRoutes()
  let readinessFailureCount = 2
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url) && readinessFailureCount > 0) {
      readinessFailureCount -= 1
      throw new Error('owner restarting')
    }

    return isRuntimeReadyUrl(url) ? getCompatibleRuntimeReadyResponse() : Response.json({data: {ok: true}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(
    new Request('http://localhost/api/projects/project-1/edit', {
      body: JSON.stringify({name: 'Updated project'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {ok: boolean}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
  const forwardedPatchUrls = ownerFetchCallUrls.filter((url) => {
    return !isRuntimeReadyUrl(url)
  })

  expect(response.status).toBe(200)
  expect(body.data.ok).toBe(true)
  expect(ownerFetchCallUrls).toHaveLength(4)
  expect(forwardedPatchUrls).toEqual(['http://owner-1:34991/__duckdb-owner-rpc/api/projects/project-1/edit'])
})

test.serial(
  'api proxy waits through owner restart before forwarding conflict-resolution POST once',
  async () => {
    const app = await loadRoutes()
    let readinessFailureCount = 20
    const fetchMock = mock(async (request: Request | URL | string) => {
      const url = getRequestUrl(request)

      if (isRuntimeReadyUrl(url) && readinessFailureCount > 0) {
        readinessFailureCount -= 1
        throw new Error('owner restarting')
      }

      return isRuntimeReadyUrl(url)
        ? getCompatibleRuntimeReadyResponse()
        : Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.handle(
      new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution', {
        body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    )
    const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}
    const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
    const forwardedPostUrls = ownerFetchCallUrls.filter((url) => {
      return !isRuntimeReadyUrl(url)
    })

    expect(response.status).toBe(200)
    expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
    expect(readinessFailureCount).toBe(0)
    expect(forwardedPostUrls).toEqual([
      'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
    ])
  },
  10_000,
)

test.serial('api proxy gives retryable conflict-resolution POSTs a restart-sized readiness budget', async () => {
  const {getDuckdbOwnerProxyRetryTimeoutMsForTesting} = await import('./ApiProxyRoutes.ts')

  expect(
    getDuckdbOwnerProxyRetryTimeoutMsForTesting({
      body: new ArrayBuffer(0),
      classification: 'owner-dependent',
      failClosedWithoutDuckdbOwner: true,
      headers: new Headers(),
      method: 'POST',
      pathname: '/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
      search: '',
    }),
  ).toBeGreaterThanOrEqual(180_000)
})

test.serial(
  'api proxy waits for conflict-resolution POST owner readiness instead of treating it as incompatible',
  async () => {
    const app = await loadRoutes()
    let notReadyCount = 2
    const fetchMock = mock(async (request: Request | URL | string) => {
      const url = getRequestUrl(request)

      if (isRuntimeReadyUrl(url) && notReadyCount > 0) {
        notReadyCount -= 1
        return getNotReadyRuntimeReadyResponse()
      }

      return isRuntimeReadyUrl(url)
        ? getCompatibleRuntimeReadyResponse()
        : Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await app.handle(
      new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution', {
        body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    )
    const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}

    expect(response.status).toBe(200)
    expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
    expect(notReadyCount).toBe(0)
  },
)

test.serial('api proxy waits for conflict-resolution POST owner URL discovery instead of failing fast', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = [null, null, 'http://owner-1:34991']

  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution', {
      body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
  const forwardedPostUrls = ownerFetchCallUrls.filter((url) => {
    return !isRuntimeReadyUrl(url)
  })

  expect(response.status).toBe(200)
  expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
  expect(forwardedPostUrls).toEqual([
    'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
  ])
})

test.serial('api proxy rediscovers moved conflict-resolution POST owner during readiness wait', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url) && url.startsWith('http://owner-1:34991')) {
      throw new Error('old owner unavailable')
    }

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991', 'http://owner-2:34992']

  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution', {
      body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
  const forwardedPostUrls = ownerFetchCallUrls.filter((url) => {
    return !isRuntimeReadyUrl(url)
  })

  expect(response.status).toBe(200)
  expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
  expect(forwardedPostUrls).toEqual([
    'http://owner-2:34992/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
  ])
})

test.serial('api proxy retries conflict-resolution POST after a temporary same-owner transport failure', async () => {
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

    return Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = ['http://owner-1:34991']

  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution', {
      body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
  const forwardedPostUrls = ownerFetchCallUrls.filter((url) => {
    return !isRuntimeReadyUrl(url)
  })

  expect(response.status).toBe(200)
  expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
  expect(forwardedPostUrls).toEqual([
    'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
    'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
  ])
})

test.serial(
  'api proxy waits for owner readiness before retrying conflict-resolution POST transport failures',
  async () => {
    const app = await loadRoutes()
    let shouldFailForward = true
    let notReadyCountAfterFailure = 3
    const fetchMock = mock(async (request: Request | URL | string) => {
      const url = getRequestUrl(request)

      if (isRuntimeReadyUrl(url)) {
        if (!shouldFailForward && notReadyCountAfterFailure > 0) {
          notReadyCountAfterFailure -= 1
          return getNotReadyRuntimeReadyResponse()
        }

        return getCompatibleRuntimeReadyResponse()
      }

      if (shouldFailForward) {
        shouldFailForward = false
        throw new Error('owner dropped after first forward')
      }

      return Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.ownerUrls = ['http://owner-1:34991']

    const response = await app.handle(
      new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution', {
        body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    )
    const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}
    const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
    const forwardedPostUrls = ownerFetchCallUrls.filter((url) => {
      return !isRuntimeReadyUrl(url)
    })

    expect(response.status).toBe(200)
    expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
    expect(notReadyCountAfterFailure).toBe(0)
    expect(forwardedPostUrls).toEqual([
      'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
      'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution',
    ])
  },
)

test.serial('api proxy treats trailing-slash conflict-resolution POST as retryable', async () => {
  const app = await loadRoutes()
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    return isRuntimeReadyUrl(url)
      ? getCompatibleRuntimeReadyResponse()
      : Response.json({data: {articleId: 'article-1', label: 'Yes', value: 'yes'}, error: null})
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.ownerUrls = [null, 'http://owner-1:34991']

  const response = await app.handle(
    new Request('http://localhost/api/comparison-projects/comparison-project-1/conflict-resolution/', {
      body: JSON.stringify({articleId: 'article-1', value: 'yes'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {articleId: string; value: string}; error: string | null}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)
  const forwardedPostUrls = ownerFetchCallUrls.filter((url) => {
    return !isRuntimeReadyUrl(url)
  })

  expect(response.status).toBe(200)
  expect(body.data).toEqual({articleId: 'article-1', label: 'Yes', value: 'yes'})
  expect(forwardedPostUrls).toEqual([
    'http://owner-1:34991/__duckdb-owner-rpc/api/comparison-projects/comparison-project-1/conflict-resolution/',
  ])
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
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/session-1/upload?replace=true',
  ])
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
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/session-1/upload?replace=true',
  ])
})

test.serial('api proxy times out wedged project transfer upload streams without buffering', async () => {
  const app = await loadRoutes()
  const timeoutMock = installFastAbortSignalTimeoutMock()
  const request = getStreamingUploadRequest({onPull: () => {}})
  const cloneMock = getRequestCloneFailureMock(request)
  const fetchMock = mock(async (request: Request | URL | string) => {
    const url = getRequestUrl(request)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    await waitForForwardedRequestAbort(request as Request)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(request)
  const body = (await response.json()) as {data: null; error: string}
  const ownerFetchCallUrls = getOwnerFetchCallUrls(fetchMock.mock.calls)

  expect(response.status).toBe(504)
  expect(body.data).toBe(null)
  expect(body.error).toContain('DuckDB owner proxy target timed out after 600000 ms')
  expect(timeoutMock).toHaveBeenCalledWith(600000)
  expect(request.bodyUsed).toBe(false)
  expect(cloneMock).toHaveBeenCalledTimes(0)
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/import/session-1/upload?replace=true',
  ])
})

test.serial('api proxy keeps the timeout active while an owner response body is streaming', async () => {
  const app = await loadRoutes()
  const timeoutMock = installFastAbortSignalTimeoutMock()
  const request = getStreamingUploadRequest({onPull: () => {}})
  let forwardedSignal: AbortSignal | null = null
  const fetchMock = mock(async (forwardedRequest: Request | URL | string) => {
    const url = getRequestUrl(forwardedRequest)

    if (isRuntimeReadyUrl(url)) {
      return getCompatibleRuntimeReadyResponse()
    }

    forwardedSignal = (forwardedRequest as Request).signal
    return new Response(
      new ReadableStream({
        start(controller) {
          forwardedSignal?.addEventListener(
            'abort',
            () => {
              controller.error(new Error('owner response aborted'))
            },
            {once: true},
          )
        },
      }),
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await app.handle(request)
  let bodyError: unknown = null

  try {
    await response.text()
  } catch (error) {
    bodyError = error
  }

  expect(bodyError).toBeInstanceOf(Error)
  expect(String(bodyError)).toContain('owner response aborted')
  expect(forwardedSignal?.aborted).toBe(true)
  expect(timeoutMock).toHaveBeenCalledWith(600000)
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
      {
        headers: {
          'content-disposition': 'attachment; filename="project-transfer-export.zip"',
          'content-type': 'application/zip',
          'x-project-transfer-checksum-sha256': 'a'.repeat(64),
          'x-project-transfer-package-fingerprint': 'fingerprint-1',
        },
      },
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
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="project-transfer-export.zip"')
  expect(response.headers.get('x-project-transfer-checksum-sha256')).toBe('a'.repeat(64))
  expect(response.headers.get('x-project-transfer-package-fingerprint')).toBe('fingerprint-1')
  expect(ownerResponse?.bodyUsed ?? true).toBe(false)
  expect(await response.text()).toBe('download-body')
  expect(ownerResponse?.bodyUsed ?? false).toBe(true)
  expect(downloadPullCount).toBeGreaterThan(0)
  expect(ownerFetchCallUrls).toEqual([
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/api/runtime/ready',
    'http://owner-1:34991/__duckdb-owner-rpc/api/projects/export/export-1/download',
  ])
})

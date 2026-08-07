import {expect, test} from 'bun:test'

import {prepareDuckdbExclusiveWork, resetDuckdbExclusiveWorkForTests} from '../utils/duckdbExclusiveWork.ts'
import {runtimeReadyPath, runtimeStatePath} from '../utils/runtimeReadyContract.ts'
import {resetServerRuntimeRoleForTests} from '../utils/serverRuntimeRole.ts'
import {classifyApiRoute, shouldApiRouteProxyToDuckdbOwner} from './apiRouteClassification.ts'
import {exposeLocalOperatorApiEnvVar} from './publicRouteSurfaceGate.ts'
import {resetRuntimeReadyOwnerProbeCacheForTests, runtimeReadyRoutes} from './runtimeReadyRoutes.ts'

type RuntimeReadyResponse = {
  data: {
    duckdbOwner: boolean
    duckdbOwnerUrl: string | null
    duckdbExclusiveWork: {active: boolean}
    localOperatorApiExposed: boolean
    ready: boolean
    settingsDiagnosticsApiExposed: boolean
  }
}

type RuntimeStateResponse = {
  data: {
    bun: {
      maxHttpRequests: {
        configuredMaxHttpRequests: number | null
        defaultMaxHttpRequests: number
        effectiveMaxHttpRequests: number
        source: string
      }
    }
    duckdbExclusiveWork: {
      active: boolean
      current: {admissionState: string; kind: string; phase: string; sessionId: string} | null
    }
  }
}

const withBunMaxHttpRequestsEnv = async (value: string | undefined, run: () => Promise<void>) => {
  const previousValue = process.env.BUN_CONFIG_MAX_HTTP_REQUESTS

  try {
    if (value === undefined) {
      delete process.env.BUN_CONFIG_MAX_HTTP_REQUESTS
    }

    if (value !== undefined) {
      process.env.BUN_CONFIG_MAX_HTTP_REQUESTS = value
    }

    await run()
  } finally {
    if (previousValue === undefined) {
      delete process.env.BUN_CONFIG_MAX_HTTP_REQUESTS
    }

    if (previousValue !== undefined) {
      process.env.BUN_CONFIG_MAX_HTTP_REQUESTS = previousValue
    }
  }
}

const withLocalOperatorApiEnv = async (value: string | undefined, run: () => Promise<void>) => {
  const previousValue = process.env[exposeLocalOperatorApiEnvVar]
  const previousRole = process.env.SERVER_ROLE
  const previousOwnerUrl = process.env.SERVER_DUCKDB_OWNER_URL

  try {
    process.env.SERVER_ROLE = 'dev-single'
    delete process.env.SERVER_DUCKDB_OWNER_URL
    resetServerRuntimeRoleForTests()

    if (value === undefined) {
      delete process.env[exposeLocalOperatorApiEnvVar]
    }

    if (value !== undefined) {
      process.env[exposeLocalOperatorApiEnvVar] = value
    }

    await run()
  } finally {
    if (previousValue === undefined) {
      delete process.env[exposeLocalOperatorApiEnvVar]
    }

    if (previousValue !== undefined) {
      process.env[exposeLocalOperatorApiEnvVar] = previousValue
    }

    if (previousRole === undefined) {
      delete process.env.SERVER_ROLE
    }

    if (previousRole !== undefined) {
      process.env.SERVER_ROLE = previousRole
    }

    if (previousOwnerUrl === undefined) {
      delete process.env.SERVER_DUCKDB_OWNER_URL
    }

    if (previousOwnerUrl !== undefined) {
      process.env.SERVER_DUCKDB_OWNER_URL = previousOwnerUrl
    }

    resetServerRuntimeRoleForTests()
  }
}

const withRuntimeOwnerEnv = async (run: () => Promise<void>, duckdbOwnerUrl?: string | null) => {
  const previousRole = process.env.SERVER_ROLE
  const previousOwnerUrl = process.env.SERVER_DUCKDB_OWNER_URL

  try {
    process.env.SERVER_ROLE = 'api'
    if (duckdbOwnerUrl === null) {
      delete process.env.SERVER_DUCKDB_OWNER_URL
    }

    if (duckdbOwnerUrl !== null) {
      process.env.SERVER_DUCKDB_OWNER_URL = duckdbOwnerUrl ?? 'http://127.0.0.1:1'
    }
    resetServerRuntimeRoleForTests()
    resetRuntimeReadyOwnerProbeCacheForTests()
    await run()
  } finally {
    if (previousRole === undefined) {
      delete process.env.SERVER_ROLE
    }

    if (previousRole !== undefined) {
      process.env.SERVER_ROLE = previousRole
    }

    if (previousOwnerUrl === undefined) {
      delete process.env.SERVER_DUCKDB_OWNER_URL
    }

    if (previousOwnerUrl !== undefined) {
      process.env.SERVER_DUCKDB_OWNER_URL = previousOwnerUrl
    }

    resetServerRuntimeRoleForTests()
    resetRuntimeReadyOwnerProbeCacheForTests()
  }
}

const getRuntimeReadyResponse = async () => {
  const response = await runtimeReadyRoutes.handle(new Request(`http://localhost${runtimeReadyPath}`))

  expect(response.ok).toBe(true)
  return (await response.json()) as RuntimeReadyResponse
}

const getRuntimeStateResponse = async () => {
  const response = await runtimeReadyRoutes.handle(new Request(`http://localhost${runtimeStatePath}`))

  expect(response.ok).toBe(true)
  return (await response.json()) as RuntimeStateResponse
}

test('runtime readiness reports local operator API exposure', async () => {
  await withLocalOperatorApiEnv('true', async () => {
    const response = await getRuntimeReadyResponse()

    expect(response.data.ready).toBe(true)
    expect(response.data.localOperatorApiExposed).toBe(true)
    expect(response.data.settingsDiagnosticsApiExposed).toBe(true)
  })

  await withLocalOperatorApiEnv(undefined, async () => {
    const response = await getRuntimeReadyResponse()

    expect(response.data.ready).toBe(true)
    expect(response.data.localOperatorApiExposed).toBe(false)
    expect(response.data.settingsDiagnosticsApiExposed).toBe(true)
  })
})

test('runtime diagnostics report active DuckDB exclusive work without making runtime unready', async () => {
  await withLocalOperatorApiEnv(undefined, async () => {
    process.env.SERVER_ROLE = 'maintenance-worker'
    resetServerRuntimeRoleForTests()

    const handle = await prepareDuckdbExclusiveWork({
      kind: 'project_transfer_import',
      phase: 'analyze',
      sessionId: 'session-1',
    })

    try {
      const readyResponse = await getRuntimeReadyResponse()
      const stateResponse = await getRuntimeStateResponse()

      expect(readyResponse.data.ready).toBe(true)
      expect(readyResponse.data.duckdbExclusiveWork.active).toBe(true)
      expect(stateResponse.data.duckdbExclusiveWork).toMatchObject({
        active: true,
        current: {admissionState: 'ready', kind: 'project_transfer_import', phase: 'analyze', sessionId: 'session-1'},
      })
    } finally {
      await handle.release()
      resetDuckdbExclusiveWorkForTests()
    }
  })
})

test('runtime readiness reports API proxy unavailable when DuckDB owner is unreachable', async () => {
  await withRuntimeOwnerEnv(async () => {
    const response = await getRuntimeReadyResponse()

    expect(response.data.ready).toBe(false)
  })
})

test('runtime readiness reports API proxy unavailable without DuckDB owner URL', async () => {
  await withRuntimeOwnerEnv(async () => {
    const response = await getRuntimeReadyResponse()

    expect(response.data.duckdbOwner).toBe(false)
    expect(response.data.duckdbOwnerUrl).toBe(null)
    expect(response.data.ready).toBe(false)
  }, null)
})

test('runtime readiness requires API proxy target to be ready DuckDB owner', async () => {
  const previousFetch = globalThis.fetch
  const responses = [
    {data: {duckdbOwner: false, ready: true, runtimeVersion: 'split-runtime-v1'}},
    {data: {duckdbOwner: true, ready: false, runtimeVersion: 'split-runtime-v1'}},
    {data: {duckdbOwner: true, ready: true, runtimeVersion: 'split-runtime-v1'}},
  ]

  try {
    globalThis.fetch = (async () => {
      return Response.json(responses.shift())
    }) as unknown as typeof fetch

    await withRuntimeOwnerEnv(async () => {
      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
      expect((await getRuntimeReadyResponse()).data.ready).toBe(true)
    }, 'http://127.0.0.1:4999')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('runtime readiness tolerates transient owner probe timeouts after a fresh ready probe', async () => {
  const previousFetch = globalThis.fetch
  const readyResponse = {data: {duckdbOwner: true, ready: true, runtimeVersion: 'split-runtime-v1'}}
  const timeoutError = new Error('The operation timed out.')
  let calls = 0

  try {
    globalThis.fetch = (async () => {
      calls += 1

      if (calls === 1) {
        return Response.json(readyResponse)
      }

      throw timeoutError
    }) as unknown as typeof fetch

    await withRuntimeOwnerEnv(async () => {
      expect((await getRuntimeReadyResponse()).data.ready).toBe(true)
      expect((await getRuntimeReadyResponse()).data.ready).toBe(true)
    }, 'http://127.0.0.1:4999')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('runtime readiness does not mask the first unreachable owner probe', async () => {
  const previousFetch = globalThis.fetch

  try {
    globalThis.fetch = (async () => {
      throw new Error('The operation timed out.')
    }) as unknown as typeof fetch

    await withRuntimeOwnerEnv(async () => {
      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
    }, 'http://127.0.0.1:4999')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('runtime readiness does not reuse a cached owner probe for another owner URL', async () => {
  const previousFetch = globalThis.fetch
  const readyResponse = {data: {duckdbOwner: true, ready: true, runtimeVersion: 'split-runtime-v1'}}

  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const normalizedUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

      if (normalizedUrl.startsWith('http://127.0.0.1:4999/')) {
        return Response.json(readyResponse)
      }

      throw new Error('The operation timed out.')
    }) as unknown as typeof fetch

    await withRuntimeOwnerEnv(async () => {
      expect((await getRuntimeReadyResponse()).data.ready).toBe(true)

      process.env.SERVER_DUCKDB_OWNER_URL = 'http://127.0.0.1:5999'
      resetServerRuntimeRoleForTests()

      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
    }, 'http://127.0.0.1:4999')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('runtime readiness clears a cached owner probe when the owner responds not ready', async () => {
  const previousFetch = globalThis.fetch
  const responses = [
    {data: {duckdbOwner: true, ready: true, runtimeVersion: 'split-runtime-v1'}},
    {data: {duckdbOwner: true, ready: false, runtimeVersion: 'split-runtime-v1'}},
  ]

  try {
    globalThis.fetch = (async () => {
      const response = responses.shift()

      if (response === undefined) {
        throw new Error('The operation timed out.')
      }

      return Response.json(response)
    }) as unknown as typeof fetch

    await withRuntimeOwnerEnv(async () => {
      expect((await getRuntimeReadyResponse()).data.ready).toBe(true)
      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
    }, 'http://127.0.0.1:4999')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('runtime readiness expires transient owner probe tolerance', async () => {
  const previousFetch = globalThis.fetch
  const previousDateNow = Date.now
  const readyResponse = {data: {duckdbOwner: true, ready: true, runtimeVersion: 'split-runtime-v1'}}
  let now = 1_000
  let calls = 0

  try {
    Date.now = () => {
      return now
    }
    globalThis.fetch = (async () => {
      calls += 1

      if (calls === 1) {
        return Response.json(readyResponse)
      }

      throw new Error('The operation timed out.')
    }) as unknown as typeof fetch

    await withRuntimeOwnerEnv(async () => {
      expect((await getRuntimeReadyResponse()).data.ready).toBe(true)

      now += 30_001

      expect((await getRuntimeReadyResponse()).data.ready).toBe(false)
    }, 'http://127.0.0.1:4999')
  } finally {
    Date.now = previousDateNow
    globalThis.fetch = previousFetch
  }
})

test('runtime state reports env configured Bun HTTP request cap', async () => {
  await withBunMaxHttpRequestsEnv('2048', async () => {
    const response = await getRuntimeStateResponse()

    expect(response.data.bun.maxHttpRequests).toMatchObject({
      configuredMaxHttpRequests: 2048,
      defaultMaxHttpRequests: 256,
      effectiveMaxHttpRequests: 2048,
      source: 'env',
    })
  })
})

test('runtime state reports Bun default HTTP request cap when env is unset', async () => {
  await withBunMaxHttpRequestsEnv(undefined, async () => {
    const response = await getRuntimeStateResponse()

    expect(response.data.bun.maxHttpRequests).toMatchObject({
      configuredMaxHttpRequests: null,
      defaultMaxHttpRequests: 256,
      effectiveMaxHttpRequests: 256,
      source: 'default',
    })
  })
})

test('runtime state route is served locally instead of proxied to the DuckDB owner', () => {
  const classification = classifyApiRoute(runtimeStatePath, 'GET')

  expect(classification).toBe('ownerless-readable-diagnostics')
  expect(shouldApiRouteProxyToDuckdbOwner(classification)).toBe(false)
})

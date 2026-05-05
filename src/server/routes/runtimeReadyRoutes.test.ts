import {expect, test} from 'bun:test'

import {runtimeStatePath} from '../utils/runtimeReadyContract.ts'
import {classifyApiRoute, shouldApiRouteProxyToDuckdbOwner} from './apiRouteClassification.ts'
import {runtimeReadyRoutes} from './runtimeReadyRoutes.ts'

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

const getRuntimeStateResponse = async () => {
  const response = await runtimeReadyRoutes.handle(new Request(`http://localhost${runtimeStatePath}`))

  expect(response.ok).toBe(true)
  return (await response.json()) as RuntimeStateResponse
}

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

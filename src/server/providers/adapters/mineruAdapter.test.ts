import {afterEach, expect, test} from 'bun:test'

import {getProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {requireProviderRegistryEntry} from '../providerRegistry.ts'
import {type ProviderConnectionRecord, type ProviderListModelsInput} from '../providerTypes.ts'
import {createMineruAdapter} from './mineruAdapter.ts'

const servers: {stop: (force?: boolean) => void}[] = []

const getConnection = (baseURL: string): ProviderConnectionRecord => {
  return {
    authMode: 'none',
    baseURL,
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    createdAt: null,
    enabled: true,
    hasSecret: false,
    id: 'mineru-connection-1',
    label: 'MinerU',
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: null,
    providerKind: 'mineru',
    secretRef: null,
    updatedAt: null,
  }
}

const getInput = (baseURL: string): ProviderListModelsInput => {
  return {connection: getConnection(baseURL), runtimeCredentials: {apiKey: null, baseURL, headers: {}, secretRef: null}}
}

const startServer = (handler: (request: Request) => Response) => {
  const server = globalThis.Bun.serve({fetch: handler, port: 0})
  servers.push(server)

  return server.url.toString().replace(/\/$/, '')
}

const getAdapter = () => {
  const catalog = getProviderCatalogEntry('mineru')

  if (!catalog) {
    throw new Error('MinerU catalog entry missing')
  }

  return createMineruAdapter(catalog)
}

const startHealthyMineru = () => {
  return startServer((request) => {
    return new URL(request.url).pathname === '/v1/health'
      ? Response.json({features: {output_formats: ['markdown', 'middle_json', 'zip']}, status: 'ok', version: '4.0.12'})
      : new Response('not found', {status: 404})
  })
}

afterEach(() => {
  servers.splice(0).forEach((server) => {
    server.stop(true)
  })
})

test('MinerU catalog entry is secretless with the mineru-api default port', () => {
  expect(getProviderCatalogEntry('mineru')).toEqual({
    defaultBaseURL: 'http://127.0.0.1:8000',
    description: 'MinerU 4 local parsing API (mineru-api) for PDF conversion',
    kind: 'mineru',
    label: 'MinerU',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  })
  expect(requireProviderRegistryEntry('mineru').transportFamily).toBe('mineru-convert')
})

test('MinerU health reports the server version from /v1/health', async () => {
  const baseURL = startHealthyMineru()
  const adapter = getAdapter()

  expect(await adapter.health(getInput(baseURL))).toEqual({
    lastError: null,
    message: 'MinerU 4.0.12 connected',
    modelCount: 1,
    ok: true,
  })
  expect((await adapter.testConnection(getInput(baseURL))).ok).toBe(true)
})

test('MinerU health fails when the server is unreachable or not ready', async () => {
  const notReadyURL = startServer(() => {
    return Response.json({error: {code: 'model_preload_failed'}}, {status: 503, statusText: 'Service Unavailable'})
  })
  const stopped = globalThis.Bun.serve({
    fetch: () => {
      return new Response('unused')
    },
    port: 0,
  })
  const unreachableURL = stopped.url.toString().replace(/\/$/, '')
  await stopped.stop(true)
  const adapter = getAdapter()

  const notReady = await adapter.health(getInput(notReadyURL))
  const unreachable = await adapter.health(getInput(unreachableURL))

  expect(notReady.ok).toBe(false)
  expect(notReady.lastError).toContain('MinerU health check failed: 503')
  expect(unreachable.ok).toBe(false)
  expect(unreachable.lastError).toBe('MinerU server did not respond at the configured base URL')
})

test('MinerU listModels returns the configured backend as one model carrying the server version', async () => {
  const baseURL = startHealthyMineru()
  const [model, ...rest] = await getAdapter().listModels(getInput(baseURL))

  expect(rest).toEqual([])
  expect(model).toMatchObject({
    displayName: 'MinerU standard',
    modelName: 'mineru-standard',
    remoteModelId: 'mineru-standard',
    variant: null,
    version: '4.0.12',
  })
  expect(model?.metadataJson).toMatchObject({
    converter: {kind: 'mineru', serverVersion: '4.0.12', tier: 'standard'},
    discovery: {identity: {remoteModelId: 'mineru-standard', version: '4.0.12'}, providerKind: 'mineru'},
  })
})

test('MinerU provider refuses judgment invocation', async () => {
  const adapter = getAdapter()
  const input = getInput('http://127.0.0.1:8000')

  const error = await adapter
    .invoke({
      connection: input.connection,
      model: {
        baseURL: null,
        createdAt: null,
        displayName: 'MinerU standard',
        enabled: true,
        id: 'model-1',
        metadataJson: null,
        modelName: 'mineru-standard',
        name: 'MinerU standard',
        provider: 'mineru',
        providerConnectionId: input.connection.id,
        remoteModelId: 'mineru-standard',
        source: 'discovered',
        updatedAt: null,
        variant: null,
        version: '4.0.12',
      },
      request: {maxCompletionTokens: 1, outputSchema: null, prompt: 'x', systemPrompt: 'y', temperature: 0},
      runtimeCredentials: input.runtimeCredentials,
    })
    .catch((caught: unknown) => {
      return caught
    })

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('MinerU provider does not support judgment invocation')
})

import {Elysia, t} from 'elysia'

import {
  beginProviderAuth,
  finishProviderAuth,
  getProviderAuthConnection,
  resolveProviderRuntimeCredentials,
} from '../providers/providerAuthService.ts'
import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from '../providers/providerConnectionHelpers.ts'
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnection,
  listProviderConnections,
  updateProviderConnection,
} from '../providers/providerConnectionRepository.ts'
import {testProviderConnectionHealth} from '../providers/providerHealthService.ts'
import {requireProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {getProviderConnectionWorkerState, getProviderRuntimeSummary} from '../providers/providerRuntimeState.ts'
import {deleteProviderSecret, storeProviderSecret} from '../providers/providerSecretStore.ts'
import {type ProviderAuthLifecyclePayload} from '../providers/providerTypes.ts'
import {
  getProviderCatalog,
  getProviderCatalogEntry,
  isCodexProvider,
  normalizeProviderKind,
} from '../services/providerCatalog.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {
  getProviderConnectionConfig,
  getProviderConnectionLabel,
  getPublicProviderConnection,
  getTrimmedValue,
} from './providerRoutes/providerRoutesShared.ts'

const getSubmittedManualWorkerUrls = ({
  manualWorkerUrls,
  workerUrls,
}: {
  manualWorkerUrls?: string[]
  workerUrls?: string[]
}) => {
  return manualWorkerUrls ?? workerUrls
}

const getPublicProviderConnectionPayload = <
  T extends {
    config: {manualWorkerUrls: string[]; workerUrlMode: 'manual' | 'runtime'}
    providerKind: string
    secretRef: string | null
  },
>(
  connection: T,
) => {
  return {
    ...getPublicProviderConnection(connection),
    workerState: getProviderConnectionWorkerState({config: connection.config, providerKind: connection.providerKind}),
  }
}

const getProviderConnectionsPayload = async () => {
  const connections = await listProviderConnections()

  return {
    catalog: getProviderCatalog(),
    connections: connections.map((connection) => {
      return getPublicProviderConnectionPayload(connection)
    }),
    runtime: getProviderRuntimeSummary(),
  }
}

export const providerConnectionsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/provider-auth/:providerKind/begin',
    async ({body, params, set}) => {
      const providerKind = normalizeProviderKind(params.providerKind)

      if (providerKind === 'unknown') {
        set.status = 400
        return {data: null, error: 'Unsupported provider'}
      }

      const connection = await getProviderAuthConnection(body.connectionId ?? null)
      const result = await beginProviderAuth({connection, providerKind})

      return {
        data: {
          result: {...result, connection: result.connection ? getPublicProviderConnection(result.connection) : null},
        },
        error: null,
      }
    },
    {body: t.Object({connectionId: t.Optional(t.String())}), params: t.Object({providerKind: t.String()})},
  )
  .post(
    '/api/provider-auth/:providerKind/finish',
    async ({body, params, set}) => {
      const providerKind = normalizeProviderKind(params.providerKind)

      if (providerKind === 'unknown') {
        set.status = 400
        return {data: null, error: 'Unsupported provider'}
      }

      const connection = await getProviderAuthConnection(body.connectionId ?? null)
      const payload = (body.payload ?? null) as ProviderAuthLifecyclePayload | null
      const result = await finishProviderAuth({connection, payload, providerKind})

      return {
        data: {
          result: {...result, connection: result.connection ? getPublicProviderConnection(result.connection) : null},
        },
        error: null,
      }
    },
    {
      body: t.Object({connectionId: t.Optional(t.String()), payload: t.Optional(t.Any())}),
      params: t.Object({providerKind: t.String()}),
    },
  )
  .get('/api/provider-connections', async () => {
    return {data: await getProviderConnectionsPayload(), error: null}
  })
  .post(
    '/api/provider-connections',
    async ({body, set}) => {
      const providerKind = normalizeProviderKind(body.providerKind)
      const catalogEntry = getProviderCatalogEntry(providerKind)
      const apiKey = getTrimmedValue(body.apiKey)

      if (providerKind === 'unknown' || !catalogEntry) {
        set.status = 400
        return {data: null, error: 'Unsupported provider'}
      }

      if (catalogEntry.requiresApiKey && !apiKey) {
        set.status = 400
        return {data: null, error: `${catalogEntry.label} API key is required`}
      }

      const baseURL = isCodexProvider(providerKind)
        ? null
        : getResolvedProviderBaseURL({baseURL: getTrimmedValue(body.baseURL), providerKind})
      const label = getProviderConnectionLabel({label: body.label, providerKind})
      const config = getProviderConnectionConfig({
        manualWorkerUrls: getSubmittedManualWorkerUrls(body),
        providerKind,
        workerUrlMode: getTrimmedValue(body.workerUrlMode),
      })
      const connection = await createProviderConnection({
        authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef: null}),
        baseURL,
        config,
        label,
        providerKind,
        secretRef: null,
      })

      try {
        const secretRef = apiKey ? await storeProviderSecret({connectionId: connection.id, secret: apiKey}) : null
        const savedConnection = secretRef
          ? await updateProviderConnection({
              authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef}),
              baseURL,
              config,
              enabled: connection.enabled,
              id: connection.id,
              label,
              secretRef,
            })
          : connection

        return {data: {connection: getPublicProviderConnectionPayload({...savedConnection, models: []})}, error: null}
      } catch (error) {
        await deleteProviderConnection(connection.id).catch(() => {
          return null
        })
        throw error
      }
    },
    {
      body: t.Object({
        apiKey: t.Optional(t.String()),
        baseURL: t.Optional(t.Union([t.String(), t.Null()])),
        label: t.Optional(t.String()),
        manualWorkerUrls: t.Optional(t.Array(t.String())),
        providerKind: t.String(),
        workerUrls: t.Optional(t.Array(t.String())),
        workerUrlMode: t.Optional(t.Union([t.Literal('manual'), t.Literal('runtime')])),
      }),
    },
  )
  .patch(
    '/api/provider-connections/:id',
    async ({body, params, set}) => {
      const existing = await getProviderConnection(params.id)

      if (!existing) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      const nextBaseURL = isCodexProvider(existing.providerKind)
        ? null
        : getResolvedProviderBaseURL({
            baseURL: body.baseURL !== undefined ? getTrimmedValue(body.baseURL) : existing.baseURL,
            providerKind: existing.providerKind,
          })
      const nextLabel = getProviderConnectionLabel({
        label: body.label !== undefined ? body.label : existing.label,
        providerKind: existing.providerKind,
      })
      const nextConfig = getProviderConnectionConfig({
        manualWorkerUrls: getSubmittedManualWorkerUrls(body) ?? existing.config.manualWorkerUrls,
        providerKind: existing.providerKind,
        workerUrlMode: getTrimmedValue(body.workerUrlMode) ?? existing.config.workerUrlMode,
      })
      const clearedSecretRef = body.clearSecret ? null : existing.secretRef

      if (body.clearSecret && existing.secretRef) {
        await deleteProviderSecret(existing.secretRef)
      }

      const secretRef = getTrimmedValue(body.apiKey)
        ? await storeProviderSecret({connectionId: existing.id, secret: body.apiKey as string})
        : clearedSecretRef
      const updated = await updateProviderConnection({
        authMode: getProviderConnectionAuthMode({baseURL: nextBaseURL, providerKind: existing.providerKind, secretRef}),
        baseURL: nextBaseURL,
        config: nextConfig,
        enabled: body.enabled ?? existing.enabled,
        id: existing.id,
        label: nextLabel,
        secretRef,
      })

      return {data: {connection: getPublicProviderConnectionPayload(updated)}, error: null}
    },
    {
      body: t.Object({
        apiKey: t.Optional(t.String()),
        baseURL: t.Optional(t.Union([t.String(), t.Null()])),
        clearSecret: t.Optional(t.Boolean()),
        enabled: t.Optional(t.Boolean()),
        label: t.Optional(t.String()),
        manualWorkerUrls: t.Optional(t.Array(t.String())),
        workerUrls: t.Optional(t.Array(t.String())),
        workerUrlMode: t.Optional(t.Union([t.Literal('manual'), t.Literal('runtime')])),
      }),
      params: t.Object({id: t.String()}),
    },
  )
  .delete(
    '/api/provider-connections/:id',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      try {
        const result = await deleteProviderConnection(connection.id)

        if (connection.secretRef) {
          await deleteProviderSecret(connection.secretRef).catch((error) => {
            console.warn(
              '[provider-connections] Failed to delete provider secret:',
              error instanceof Error ? error.message : error,
            )
          })
        }

        return {data: result, error: null}
      } catch (error) {
        set.status = 400
        return {data: null, error: error instanceof Error ? error.message : 'Failed to remove provider connection'}
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/provider-connections/:id/test',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      const result = await testProviderConnectionHealth(connection)

      if (!result.ok) {
        set.status = 400
        return {data: null, error: result.message}
      }

      return {data: {message: result.message, modelCount: result.modelCount}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/provider-connections/:id/discovered-models',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      const definition = requireProviderRegistryEntry(connection.providerKind)
      const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)
      const models = await definition.listModels({connection, runtimeCredentials})

      return {data: {models}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )

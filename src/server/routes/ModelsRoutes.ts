import {Elysia, t} from 'elysia'

import {resolveProviderRuntimeCredentials} from '../providers/providerAuthService.ts'
import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from '../providers/providerConnectionHelpers.ts'
import {
  createProviderConnection,
  deleteProviderConnection,
  getFirstEnabledProviderConnection,
  getProviderConnection,
  listProviderConnections,
  updateProviderConnection,
} from '../providers/providerConnectionRepository.ts'
import {testProviderConnectionHealth} from '../providers/providerHealthService.ts'
import {
  createProviderModel,
  listSelectableProviderModels,
  updateProviderModel,
} from '../providers/providerModelRepository.ts'
import {requireProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {deleteProviderSecret, storeProviderSecret} from '../providers/providerSecretStore.ts'
import {syncProviderConnectionModels} from '../providers/providerSyncService.ts'
import {
  getCodexAppDeviceLoginJob,
  getCodexAppRuntimeStatus,
  startCodexAppDeviceLogin,
} from '../providers/transports/codexAppTransport.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  getProviderCatalog,
  getProviderCatalogEntry,
  isCodexProvider,
  normalizeProviderKind,
} from '../services/providerCatalog.ts'
import {env} from '../utils/env.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const normalizeDisplayName = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : 'Codex model'
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const toCodexVirtualId = (modelName: string, effort?: string | null): string => {
  const trimmedEffort = String(effort ?? '').trim()
  return trimmedEffort.length > 0 ? `codex:${modelName}:${trimmedEffort}` : `codex:${modelName}`
}

const getProviderConnectionLabel = ({
  label,
  providerKind,
}: {
  label: string | null | undefined
  providerKind: string
}) => {
  return getTrimmedValue(label) ?? getProviderCatalogEntry(providerKind)?.label ?? 'Provider connection'
}

const getProviderConnectionConfig = (workerUrls: string[] | null | undefined) => {
  return {
    workerUrls: (workerUrls ?? [])
      .map((url) => {
        return String(url).trim()
      })
      .filter((url) => {
        return url.length > 0
      }),
  }
}

const getPublicProviderConnection = <T extends {secretRef: string | null}>(connection: T) => {
  const {secretRef: _secretRef, ...rest} = connection
  return rest
}

const getProviderConnectionsPayload = async () => {
  const connections = await listProviderConnections()

  return {
    catalog: getProviderCatalog(),
    connections: connections.map((connection) => {
      return getPublicProviderConnection(connection)
    }),
  }
}

const getCodexVirtualModelsFromStoredModels = async () => {
  const storedModels = await listSelectableProviderModels()

  return storedModels
    .filter((model) => {
      return model.provider === 'codex' && typeof model.modelName === 'string' && model.modelName.trim().length > 0
    })
    .map((model) => {
      const modelName = String(model.modelName).trim()
      const effort = getTrimmedValue(model.variant ?? model.version)

      return {
        apiKeyVariable: null,
        baseURL: null,
        createdAt: model.createdAt,
        id: toCodexVirtualId(modelName, effort),
        modelName,
        name: model.displayName ?? model.name,
        provider: 'codex',
        updatedAt: model.updatedAt,
        version: effort,
        workerUrls: null,
      }
    })
}

const getCodexVirtualModelsFromServer = async () => {
  const connection = await getFirstEnabledProviderConnection('codex')

  if (!connection) {
    return []
  }

  try {
    const definition = requireProviderRegistryEntry(connection.providerKind)
    const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)
    const discoveredModels = await definition.listModels({connection, runtimeCredentials})

    return discoveredModels.map((model) => {
      return {
        apiKeyVariable: null,
        baseURL: null,
        createdAt: null,
        id: toCodexVirtualId(model.modelName, model.variant ?? model.version),
        modelName: model.modelName,
        name: model.displayName,
        provider: 'codex',
        updatedAt: null,
        version: model.variant ?? model.version,
        workerUrls: null,
      }
    })
  } catch (error) {
    console.warn('[models] Failed to load Codex models:', error instanceof Error ? error.message : error)
    return []
  }
}

const getSelectableModelsPayload = async () => {
  const storedModels = await listSelectableProviderModels()
  const nonCodexModels = storedModels
    .filter((model) => {
      return model.provider !== 'codex'
    })
    .map((model) => {
      return {
        apiKeyVariable: null,
        baseURL: model.baseURL,
        createdAt: model.createdAt,
        id: model.id,
        modelName: model.modelName,
        name: model.displayName ?? model.name,
        provider: model.provider,
        updatedAt: model.updatedAt,
        version: model.variant ?? model.version,
        workerUrls: null,
      }
    })
  const codexVirtualFromServer = await getCodexVirtualModelsFromServer()
  const codexVirtualFromDb = await getCodexVirtualModelsFromStoredModels()
  const codexModels = codexVirtualFromServer.length > 0 ? codexVirtualFromServer : codexVirtualFromDb

  return [...nonCodexModels, ...codexModels]
}

const getCodexConnectionForEnsure = async () => {
  const existing = await getFirstEnabledProviderConnection('codex')

  return existing
    ? existing
    : createProviderConnection({
        authMode: 'codex-cli',
        baseURL: null,
        config: {workerUrls: []},
        label: 'Codex',
        providerKind: 'codex',
        secretRef: null,
      })
}

export const modelsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia()
      .get('/api/models', async () => {
        return {data: await getSelectableModelsPayload()}
      })
      .get('/api/models/stored', async () => {
        const payload = await getProviderConnectionsPayload()
        return {
          data: payload.connections.flatMap((connection) => {
            return connection.models
          }),
        }
      })
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
          const connection = await createProviderConnection({
            authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef: null}),
            baseURL,
            config: getProviderConnectionConfig(body.workerUrls),
            label,
            providerKind,
            secretRef: null,
          })
          const secretRef = apiKey ? await storeProviderSecret({connectionId: connection.id, secret: apiKey}) : null
          const savedConnection = secretRef
            ? await updateProviderConnection({
                authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef}),
                baseURL,
                config: getProviderConnectionConfig(body.workerUrls),
                enabled: connection.enabled,
                id: connection.id,
                label,
                secretRef,
              })
            : connection

          return {data: {connection: getPublicProviderConnection({...savedConnection, models: []})}, error: null}
        },
        {
          body: t.Object({
            apiKey: t.Optional(t.String()),
            baseURL: t.Optional(t.Union([t.String(), t.Null()])),
            label: t.Optional(t.String()),
            providerKind: t.String(),
            workerUrls: t.Optional(t.Array(t.String())),
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
          const nextConfig = getProviderConnectionConfig(body.workerUrls ?? existing.config.workerUrls)
          const clearedSecretRef = body.clearSecret ? null : existing.secretRef

          if (body.clearSecret && existing.secretRef) {
            await deleteProviderSecret(existing.secretRef)
          }

          const secretRef = getTrimmedValue(body.apiKey)
            ? await storeProviderSecret({connectionId: existing.id, secret: body.apiKey as string})
            : clearedSecretRef
          const updated = await updateProviderConnection({
            authMode: getProviderConnectionAuthMode({
              baseURL: nextBaseURL,
              providerKind: existing.providerKind,
              secretRef,
            }),
            baseURL: nextBaseURL,
            config: nextConfig,
            enabled: body.enabled ?? existing.enabled,
            id: existing.id,
            label: nextLabel,
            secretRef,
          })

          return {data: {connection: getPublicProviderConnection(updated)}, error: null}
        },
        {
          body: t.Object({
            apiKey: t.Optional(t.String()),
            baseURL: t.Optional(t.Union([t.String(), t.Null()])),
            clearSecret: t.Optional(t.Boolean()),
            enabled: t.Optional(t.Boolean()),
            label: t.Optional(t.String()),
            workerUrls: t.Optional(t.Array(t.String())),
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

          const result = await deleteProviderConnection(connection.id)

          if (connection.secretRef) {
            await deleteProviderSecret(connection.secretRef).catch((error) => {
              console.warn(
                '[provider-connections] Failed to delete provider secret:',
                error instanceof Error ? error.message : error,
              )
            })
          }

          return {data: {deleted: true, ...result}, error: null}
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
      .post(
        '/api/provider-connections/:id/sync-models',
        async ({params, set}) => {
          const connection = await getProviderConnection(params.id)

          if (!connection) {
            set.status = 404
            return {data: null, error: 'Provider connection not found'}
          }

          try {
            const result = await syncProviderConnectionModels(connection)

            return {data: {count: result.savedModels.length, models: result.savedModels}, error: null}
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Provider model sync failed'
            set.status = 400
            return {data: null, error: message}
          }
        },
        {params: t.Object({id: t.String()})},
      )
      .post(
        '/api/provider-connections/:id/models',
        async ({body, params, set}) => {
          const connection = await getProviderConnection(params.id)

          if (!connection) {
            set.status = 404
            return {data: null, error: 'Provider connection not found'}
          }

          const remoteModelId = getTrimmedValue(body.remoteModelId)

          if (!remoteModelId) {
            set.status = 400
            return {data: null, error: 'remoteModelId is required'}
          }

          const variant = getTrimmedValue(body.variant)
          const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
            SELECT id
            FROM app.model
            WHERE provider_connection_id = ${getSqlLiteral(connection.id)}
              AND remote_model_id = ${getSqlLiteral(remoteModelId)}
              AND ${variant ? `variant = ${getSqlLiteral(variant)}` : 'variant IS NULL'}
            LIMIT 1
          `)

          if (existing) {
            return {data: {model: null, modelId: existing.id}, error: null}
          }

          const model = await createProviderModel({
            connection,
            displayName: getTrimmedValue(body.displayName) ?? remoteModelId,
            metadataJson: null,
            modelName: remoteModelId,
            remoteModelId,
            source: 'manual',
            variant,
            version: variant,
          })

          return {data: {model, modelId: model.id}, error: null}
        },
        {
          body: t.Object({
            displayName: t.Optional(t.String()),
            remoteModelId: t.String(),
            variant: t.Optional(t.String()),
          }),
          params: t.Object({id: t.String()}),
        },
      )
      .patch(
        '/api/models/:id',
        async ({body, params, set}) => {
          const displayName = getTrimmedValue(body.displayName)

          if (!displayName) {
            set.status = 400
            return {data: null, error: 'displayName is required'}
          }

          const model = await updateProviderModel({
            displayName,
            enabled: body.enabled,
            id: params.id,
            variant: getTrimmedValue(body.variant),
          })

          return {data: {model}, error: null}
        },
        {
          body: t.Object({displayName: t.String(), enabled: t.Boolean(), variant: t.Optional(t.String())}),
          params: t.Object({id: t.String()}),
        },
      )
      .get('/api/models/codex/status', async () => {
        return {data: await getCodexAppRuntimeStatus(), error: null}
      })
      .post('/api/models/codex/login', async () => {
        const status = await getCodexAppRuntimeStatus()
        const cli = status.cli
        if (cli.ok && cli.loggedIn) {
          return {data: {started: false, job: null, message: 'Already logged in.'}, error: null}
        }
        const job = startCodexAppDeviceLogin()
        return {data: {started: true, job, message: 'Started Codex device login.'}, error: null}
      })
      .get(
        '/api/models/codex/login/:jobId',
        async ({params, set}) => {
          const job = getCodexAppDeviceLoginJob(params.jobId)
          if (!job) {
            set.status = 404
            return {data: null, error: 'Login job not found'}
          }
          return {data: job, error: null}
        },
        {params: t.Object({jobId: t.String()})},
      )
      .post(
        '/api/models/ensure',
        async ({body, set}) => {
          if (normalizeProviderKind(body.provider) !== 'codex') {
            set.status = 400
            return {data: null, error: 'Unsupported provider'}
          }

          const modelName = body.modelName.trim()
          if (!modelName) {
            set.status = 400
            return {data: null, error: 'modelName is required'}
          }

          const version = getTrimmedValue(body.version)
          const connection = await getCodexConnectionForEnsure()
          const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
            SELECT id
            FROM app.model
            WHERE provider_connection_id = ${getSqlLiteral(connection.id)}
              AND remote_model_id = ${getSqlLiteral(modelName)}
              AND ${version ? `variant = ${getSqlLiteral(version)}` : 'variant IS NULL'}
            LIMIT 1
          `)

          if (existing) {
            return {data: {modelId: existing.id}, error: null}
          }

          const model = await createProviderModel({
            connection,
            displayName: normalizeDisplayName(body.name),
            metadataJson: null,
            modelName,
            remoteModelId: modelName,
            source: 'manual',
            variant: version,
            version,
          })

          return {data: {modelId: model.id}, error: null}
        },
        {
          body: t.Object({
            modelName: t.String(),
            name: t.String(),
            provider: t.String(),
            version: t.Optional(t.String()),
          }),
        },
      ),
  )
  .use(
    new Elysia().get('/api/models/gpu-info', async () => {
      return {
        data: {
          DP_SIZE: env.DP_SIZE,
          GPU_GPUS_PER_NODE: env.GPU_GPUS_PER_NODE,
          GPU_NNODES: env.GPU_NNODES,
          GPU_SHAPE: env.GPU_SHAPE,
          GPU_TOTAL_GPUS: env.GPU_TOTAL_GPUS,
          SGLANG_MAX_RUNNING_REQUESTS: env.SGLANG_MAX_RUNNING_REQUESTS,
          TP_SIZE: env.TP_SIZE,
        },
      }
    }),
  )

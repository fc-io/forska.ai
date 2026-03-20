import {Elysia, t} from 'elysia'

import {resolveProviderRuntimeCredentials} from '../providers/providerAuthService.ts'
import {
  createProviderConnection,
  getFirstEnabledProviderConnection,
  listProviderConnections,
} from '../providers/providerConnectionRepository.ts'
import {createProviderModel, listSelectableProviderModels} from '../providers/providerModelRepository.ts'
import {requireProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {
  getCodexAppDeviceLoginJob,
  getCodexAppRuntimeStatus,
  startCodexAppDeviceLogin,
} from '../providers/transports/codexAppTransport.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {inferenceRuntimeConfig} from '../utils/getInferenceRuntimeConfig.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {providerConnectionsRoutes} from './ProviderConnectionsRoutes.ts'
import {providerModelsRoutes} from './ProviderModelsRoutes.ts'
import {getTrimmedValue, normalizeDisplayName} from './providerRoutes/providerRoutesShared.ts'

const toCodexVirtualId = (modelName: string, effort?: string | null): string => {
  const trimmedEffort = String(effort ?? '').trim()

  return trimmedEffort.length > 0 ? `codex:${modelName}:${trimmedEffort}` : `codex:${modelName}`
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
  .get('/api/models', async () => {
    return {data: await getSelectableModelsPayload()}
  })
  .get('/api/models/stored', async () => {
    const connections = await listProviderConnections()

    return {
      data: connections.flatMap((connection) => {
        return connection.models
      }),
    }
  })
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
    {body: t.Object({modelName: t.String(), name: t.String(), provider: t.String(), version: t.Optional(t.String())})},
  )
  .use(providerConnectionsRoutes)
  .use(providerModelsRoutes)
  .get('/api/models/gpu-info', async () => {
    return {
      data: {
        DP_SIZE: inferenceRuntimeConfig.dpSize,
        GPU_GPUS_PER_NODE: inferenceRuntimeConfig.gpuGpusPerNode,
        GPU_NNODES: inferenceRuntimeConfig.gpuNnodes,
        GPU_SHAPE: inferenceRuntimeConfig.gpuShape,
        GPU_TOTAL_GPUS: inferenceRuntimeConfig.gpuTotalGpus,
        SGLANG_MAX_RUNNING_REQUESTS: inferenceRuntimeConfig.sglangMaxRunningRequests,
        TP_SIZE: inferenceRuntimeConfig.tpSize,
      },
    }
  })

import {Elysia, t} from 'elysia'

import {resolveProviderRuntimeCredentials} from '../providers/providerAuthService.ts'
import {
  createProviderConnection,
  getFirstEnabledProviderConnection,
  listProviderConnections,
} from '../providers/providerConnectionRepository.ts'
import {getManualProviderModelMetadata} from '../providers/providerModelMetadata.ts'
import {createProviderModel, listSelectableProviderModels} from '../providers/providerModelRepository.ts'
import {requireProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {type ProviderModelRecord} from '../providers/providerTypes.ts'
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

const getCodexStoredModels = async (): Promise<ProviderModelRecord[]> => {
  const connections = await listProviderConnections()

  return connections.flatMap((connection) => {
    return connection.providerKind === 'codex' ? connection.models : []
  })
}

const getCodexStoredModelKey = (model: {
  modelName: string | null
  remoteModelId: string | null
  variant: string | null
  version: string | null
}) => {
  const modelName = getTrimmedValue(model.remoteModelId) ?? getTrimmedValue(model.modelName) ?? 'codex'
  const effort = getTrimmedValue(model.variant ?? model.version)

  return toCodexVirtualId(modelName, effort)
}

const getSelectableCodexModel = ({
  createdAt,
  displayName,
  modelName,
  updatedAt,
  version,
}: {
  createdAt: Date | null
  displayName: string
  modelName: string
  updatedAt: Date | null
  version: string | null
}) => {
  return {
    apiKeyVariable: null,
    baseURL: null,
    createdAt,
    id: toCodexVirtualId(modelName, version),
    modelName,
    name: displayName,
    provider: 'codex',
    updatedAt,
    version,
    workerUrls: null,
  }
}

const getCodexVirtualModelsFromStoredModels = async (storedModels: ProviderModelRecord[]) => {
  return storedModels
    .filter((model) => {
      return (
        model.enabled
        && model.provider === 'codex'
        && typeof model.modelName === 'string'
        && model.modelName.trim().length > 0
      )
    })
    .map((model) => {
      const modelName = String(model.modelName).trim()
      const effort = getTrimmedValue(model.variant ?? model.version)

      return getSelectableCodexModel({
        createdAt: model.createdAt,
        displayName: model.displayName ?? model.name,
        modelName,
        updatedAt: model.updatedAt,
        version: effort,
      })
    })
}

const getCodexVirtualModelsFromServer = async (storedModels: ProviderModelRecord[]) => {
  const connection = await getFirstEnabledProviderConnection('codex')

  if (!connection) {
    return []
  }

  try {
    const definition = requireProviderRegistryEntry(connection.providerKind)
    const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)
    const discoveredModels = await definition.listModels({connection, runtimeCredentials})
    const storedModelMap = new Map(
      storedModels.map((model) => {
        return [getCodexStoredModelKey(model), model]
      }),
    )
    const discoveredIds = new Set<string>()
    const mergedDiscoveredModels = discoveredModels
      .filter((model) => {
        const modelId = toCodexVirtualId(model.modelName, model.variant ?? model.version)
        const storedModel = storedModelMap.get(modelId)

        discoveredIds.add(modelId)

        return storedModel?.enabled ?? true
      })
      .map((model) => {
        return getSelectableCodexModel({
          createdAt: null,
          displayName: model.displayName,
          modelName: model.modelName,
          updatedAt: null,
          version: model.variant ?? model.version,
        })
      })
    const missingStoredModels = storedModels
      .filter((model) => {
        return model.enabled && !discoveredIds.has(getCodexStoredModelKey(model))
      })
      .map((model) => {
        return getSelectableCodexModel({
          createdAt: model.createdAt,
          displayName: model.displayName ?? model.name,
          modelName: String(model.modelName ?? model.remoteModelId ?? model.name).trim(),
          updatedAt: model.updatedAt,
          version: getTrimmedValue(model.variant ?? model.version),
        })
      })

    return [...mergedDiscoveredModels, ...missingStoredModels]
  } catch (error) {
    console.warn('[models] Failed to load Codex models:', error instanceof Error ? error.message : error)
    return []
  }
}

const getSelectableModelsPayload = async () => {
  const storedModels = await listSelectableProviderModels()
  const storedCodexModels = await getCodexStoredModels()
  const nonCodexModels = storedModels
    .filter((model) => {
      return model.provider !== 'codex' && model.provider !== 'docling'
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
  const codexVirtualFromServer = await getCodexVirtualModelsFromServer(storedCodexModels)
  const codexVirtualFromDb = await getCodexVirtualModelsFromStoredModels(storedCodexModels)
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
        config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
        label: 'Codex',
        maxInflightRequests: null,
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
      const displayName = normalizeDisplayName(body.name)
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
        displayName,
        metadataJson: getManualProviderModelMetadata({
          displayName,
          modelName,
          providerKind: connection.providerKind,
          remoteModelId: modelName,
          variant: version,
          version,
        }),
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

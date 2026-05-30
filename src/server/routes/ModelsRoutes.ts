import {Elysia, t} from 'elysia'

import {getAnthropicSupportedThinkingEfforts} from '../../utils/anthropicThinking.ts'
import {
  appendProviderModelThinkingBadgeLabel,
  getProviderModelThinkingBadgeValue,
} from '../../utils/providerModelLabel.ts'
import {getProviderModelThinkingOption} from '../../utils/providerModelOptions.ts'
import {resolveProviderRuntimeCredentials} from '../providers/providerAuthService.ts'
import {
  createProviderConnection,
  getFirstEnabledProviderConnection,
  listProviderConnections,
} from '../providers/providerConnectionRepository.ts'
import {getManualProviderModelMetadata, getProviderModelMetadataOptions} from '../providers/providerModelMetadata.ts'
import {
  createProviderModel,
  listSelectableProviderModels,
  updateProviderModel,
} from '../providers/providerModelRepository.ts'
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
import {getInferenceRuntimeConfig} from '../utils/getInferenceRuntimeConfig.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {providerConnectionsRoutes} from './ProviderConnectionsRoutes.ts'
import {providerModelsRoutes} from './ProviderModelsRoutes.ts'
import {getTrimmedValue, normalizeDisplayName} from './providerRoutes/providerRoutesShared.ts'

const toCodexVirtualId = (modelName: string, effort?: string | null): string => {
  const trimmedEffort = String(effort ?? '').trim()

  return trimmedEffort.length > 0 ? `codex:${modelName}:${trimmedEffort}` : `codex:${modelName}`
}

const toAnthropicVirtualId = (modelName: string, effort: string): string => {
  return `anthropic:${modelName}:${effort}`
}

const getCodexStoredModels = async (): Promise<ProviderModelRecord[]> => {
  const connections = await listProviderConnections()

  return connections.flatMap((connection) => {
    return connection.enabled && connection.providerKind === 'codex' ? connection.models : []
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
  providerConnectionId,
  updatedAt,
  version,
}: {
  createdAt: Date | null
  displayName: string
  modelName: string
  providerConnectionId: string | null
  updatedAt: Date | null
  version: string | null
}) => {
  return {
    apiKeyVariable: null,
    baseURL: null,
    createdAt,
    id: toCodexVirtualId(modelName, version),
    label: `Codex: ${displayName}`,
    modelName,
    name: displayName,
    provider: 'codex',
    providerConnectionId,
    updatedAt,
    version,
    workerUrls: null,
  }
}

const getSelectableModelLabel = ({
  metadataJson,
  name,
  provider,
  version,
}: {
  metadataJson: unknown
  name: string
  provider: string | null
  version?: string | null
}) => {
  const baseLabel = provider === 'codex' ? `Codex: ${name}` : name

  return appendProviderModelThinkingBadgeLabel({
    label: baseLabel,
    thinking: getProviderModelThinkingBadgeValue({
      provider,
      thinking: getProviderModelMetadataOptions(metadataJson).thinking,
      version: version ?? null,
    }),
  })
}

const getSelectableStoredModel = (model: ProviderModelRecord) => {
  return {
    apiKeyVariable: null,
    baseURL: model.baseURL,
    createdAt: model.createdAt,
    id: model.id,
    label: getSelectableModelLabel({
      metadataJson: model.metadataJson,
      name: model.displayName ?? model.name,
      provider: model.provider,
      version: model.variant ?? model.version,
    }),
    modelName: model.modelName,
    name: model.displayName ?? model.name,
    provider: model.provider,
    providerConnectionId: model.providerConnectionId,
    updatedAt: model.updatedAt,
    version: model.variant ?? model.version,
    workerUrls: null,
  }
}

const getAnthropicStoredModelKey = (model: {
  modelName: string | null
  remoteModelId: string | null
  variant: string | null
  version: string | null
}) => {
  const modelName = getTrimmedValue(model.remoteModelId) ?? getTrimmedValue(model.modelName) ?? 'anthropic'
  const effort = getTrimmedValue(model.variant ?? model.version) ?? 'base'

  return `${modelName}:${effort}`
}

const getSelectableAnthropicVirtualModel = ({
  baseURL,
  createdAt,
  displayName,
  id,
  modelName,
  providerConnectionId,
  updatedAt,
  version,
}: {
  baseURL: string | null
  createdAt: Date | null
  displayName: string
  id: string
  modelName: string
  providerConnectionId: string | null
  updatedAt: Date | null
  version: string | null
}) => {
  return {
    apiKeyVariable: null,
    baseURL,
    createdAt,
    id,
    label: getSelectableModelLabel({metadataJson: null, name: displayName, provider: 'anthropic', version}),
    modelName,
    name: displayName,
    provider: 'anthropic',
    providerConnectionId,
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
        providerConnectionId: model.providerConnectionId,
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
          providerConnectionId: connection.id,
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
          providerConnectionId: model.providerConnectionId,
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

const getAnthropicSelectableModels = (storedModels: ProviderModelRecord[]) => {
  const anthropicModels = storedModels.filter((model) => {
    return model.provider === 'anthropic'
  })
  const storedVariants = new Map(
    anthropicModels.map((model) => {
      return [getAnthropicStoredModelKey(model), model]
    }),
  )
  const usedModelIds = new Set<string>()
  const modelsFromBaseRows = anthropicModels.flatMap((model) => {
    const currentVersion = getTrimmedValue(model.variant ?? model.version)
    const modelName = getTrimmedValue(model.remoteModelId) ?? getTrimmedValue(model.modelName)

    if (currentVersion || !modelName) {
      return []
    }

    const baseDisplayName = model.displayName ?? model.name
    const supportedEfforts = getAnthropicSupportedThinkingEfforts(modelName)

    usedModelIds.add(model.id)

    return [
      getSelectableStoredModel(model),
      ...supportedEfforts.map((effort) => {
        const storedVariant = storedVariants.get(
          getAnthropicStoredModelKey({modelName, remoteModelId: modelName, variant: effort, version: effort}),
        )

        if (storedVariant) {
          usedModelIds.add(storedVariant.id)

          return getSelectableStoredModel(storedVariant)
        }

        return getSelectableAnthropicVirtualModel({
          baseURL: model.baseURL,
          createdAt: model.createdAt,
          displayName: appendProviderModelThinkingBadgeLabel({label: baseDisplayName, thinking: effort}),
          id: toAnthropicVirtualId(modelName, effort),
          modelName,
          providerConnectionId: model.providerConnectionId,
          updatedAt: model.updatedAt,
          version: effort,
        })
      }),
    ]
  })
  const remainingStoredModels = anthropicModels
    .filter((model) => {
      return !usedModelIds.has(model.id)
    })
    .map(getSelectableStoredModel)

  return [...modelsFromBaseRows, ...remainingStoredModels]
}

const getSelectableModelsPayload = async () => {
  const storedModels = await listSelectableProviderModels()
  const storedCodexModels = await getCodexStoredModels()
  const nonCodexModels = storedModels
    .filter((model) => {
      return model.provider !== 'anthropic' && model.provider !== 'codex' && model.provider !== 'docling'
    })
    .map(getSelectableStoredModel)
  const anthropicModels = getAnthropicSelectableModels(storedModels)
  const codexVirtualFromServer = await getCodexVirtualModelsFromServer(storedCodexModels)
  const codexVirtualFromDb = await getCodexVirtualModelsFromStoredModels(storedCodexModels)
  const codexModels = codexVirtualFromServer.length > 0 ? codexVirtualFromServer : codexVirtualFromDb

  return [...nonCodexModels, ...anthropicModels, ...codexModels]
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
        return connection.models.map((model) => {
          return {
            ...model,
            label: getSelectableModelLabel({
              metadataJson: model.metadataJson,
              name: model.displayName ?? model.name,
              provider: model.provider,
              version: model.variant ?? model.version,
            }),
          }
        })
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
      const provider = normalizeProviderKind(body.provider)

      if (provider !== 'codex') {
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
      const thinking = version ? getProviderModelThinkingOption(version) : null
      const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.model
        WHERE provider_connection_id = ${getSqlLiteral(connection.id)}
          AND remote_model_id = ${getSqlLiteral(modelName)}
          AND ${version ? `variant = ${getSqlLiteral(version)}` : 'variant IS NULL'}
        LIMIT 1
      `)

      if (existing) {
        const model = await updateProviderModel({
          displayName,
          enabled: true,
          id: existing.id,
          options: {thinking},
          variant: version,
        })

        return {data: {modelId: model.id}, error: null}
      }

      const model = await createProviderModel({
        connection,
        displayName,
        metadataJson: getManualProviderModelMetadata({
          displayName,
          modelName,
          options: {thinking},
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
    const runtimeConfig = getInferenceRuntimeConfig()

    return {
      data: {
        DP_SIZE: runtimeConfig.dpSize,
        GPU_GPUS_PER_NODE: runtimeConfig.gpuGpusPerNode,
        GPU_NNODES: runtimeConfig.gpuNnodes,
        GPU_SHAPE: runtimeConfig.gpuShape,
        GPU_TOTAL_GPUS: runtimeConfig.gpuTotalGpus,
        SGLANG_MAX_RUNNING_REQUESTS: runtimeConfig.sglangMaxRunningRequests,
        TP_SIZE: runtimeConfig.tpSize,
      },
    }
  })

import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {getNormalizedProviderModelMetadata} from '../providerModelMetadata.ts'
import {discoverOpenAICompatibleRuntimeModel} from '../providerRuntimeDiscovery.ts'
import {
  type ProviderDefinition,
  type ProviderHealthResult,
  type ProviderInvocationResult,
  type ProviderInvokeInput,
  type ProviderListedModel,
} from '../providerTypes.ts'
import {invokeOpenAIChatModel, listNativeOllamaModels, listOpenAIChatModels} from '../transports/openaiChatTransport.ts'
import {
  beginApiKeyProviderAuth,
  beginSecretlessProviderAuth,
  finishApiKeyProviderAuth,
  finishSecretlessProviderAuth,
  getProviderConnectedMessage,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveApiKeyRuntimeCredentials,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

type OpenAICompatibleAdapterOptions = {
  authFlow?: 'api-key' | 'optional-api-key' | 'secretless'
  transportFamily: ProviderDefinition['transportFamily']
  useNativeOllamaDiscovery?: boolean
}

const getProviderModelName = ({
  modelName,
  name,
  remoteModelId,
}: {
  modelName: string | null
  name: string
  remoteModelId: string | null
}) => {
  return modelName ?? remoteModelId ?? name
}

const shouldUseRuntimeMetadata = ({
  listedModel,
  modelCount,
  runtimeMetadata,
}: {
  listedModel: ProviderListedModel
  modelCount: number
  runtimeMetadata: Awaited<ReturnType<typeof discoverOpenAICompatibleRuntimeModel>>
}) => {
  const runtimeNames = [runtimeMetadata?.modelName, runtimeMetadata?.servedModelName].filter(
    (value): value is string => {
      return typeof value === 'string' && value.trim().length > 0
    },
  )

  return (
    modelCount === 1
    || runtimeNames.some((runtimeName) => {
      return runtimeName === listedModel.modelName || runtimeName === listedModel.remoteModelId
    })
  )
}

const getRuntimeOnlyListedModel = ({
  providerKind,
  runtimeMetadata,
}: {
  providerKind: ProviderCatalogEntry['kind']
  runtimeMetadata: NonNullable<Awaited<ReturnType<typeof discoverOpenAICompatibleRuntimeModel>>>
}): ProviderListedModel => {
  const runtimeModelName = runtimeMetadata.servedModelName ?? runtimeMetadata.modelName ?? 'runtime-model'

  return {
    displayName: runtimeModelName,
    metadataJson: getNormalizedProviderModelMetadata({
      listedModel: {
        displayName: runtimeModelName,
        metadataJson: runtimeMetadata.raw,
        modelName: runtimeModelName,
        remoteModelId: runtimeModelName,
        variant: null,
        version: null,
      },
      providerKind,
      rawMetadata: runtimeMetadata.raw,
      runtimeMetadata,
      source: 'runtime',
    }),
    modelName: runtimeModelName,
    remoteModelId: runtimeModelName,
    variant: null,
    version: null,
  }
}

const getNormalizedListedModel = ({
  listedModel,
  providerKind,
  runtimeMetadata,
  source,
}: {
  listedModel: ProviderListedModel
  providerKind: ProviderCatalogEntry['kind']
  runtimeMetadata?: Awaited<ReturnType<typeof discoverOpenAICompatibleRuntimeModel>>
  source: 'provider' | 'runtime'
}): ProviderListedModel => {
  return {
    ...listedModel,
    metadataJson: getNormalizedProviderModelMetadata({
      listedModel,
      providerKind,
      rawMetadata: listedModel.metadataJson,
      runtimeMetadata: runtimeMetadata ?? null,
      source,
    }),
  }
}

export const createOpenAICompatibleAdapter = (
  catalog: ProviderCatalogEntry,
  options: OpenAICompatibleAdapterOptions,
): ProviderDefinition => {
  const listCompatibleModels = async ({
    apiKey,
    baseURL,
  }: {
    apiKey: string | null
    baseURL: string | null
  }): Promise<ProviderListedModel[]> => {
    const runtimeMetadata = await discoverOpenAICompatibleRuntimeModel({baseURL, providerKind: catalog.kind})
    if (options.useNativeOllamaDiscovery) {
      try {
        const models = await listNativeOllamaModels({baseURL})

        return models.map((listedModel) => {
          return getNormalizedListedModel({listedModel, providerKind: catalog.kind, source: 'provider'})
        })
      } catch {
        const models = await listOpenAIChatModels({apiKey, baseURL, providerLabel: catalog.label})

        return models.map((listedModel) => {
          return getNormalizedListedModel({listedModel, providerKind: catalog.kind, source: 'provider'})
        })
      }
    }

    const listedModels = await listOpenAIChatModels({apiKey, baseURL, providerLabel: catalog.label})

    return listedModels.length === 0 && runtimeMetadata
      ? [getRuntimeOnlyListedModel({providerKind: catalog.kind, runtimeMetadata})]
      : listedModels.map((listedModel) => {
          return getNormalizedListedModel({
            listedModel,
            providerKind: catalog.kind,
            runtimeMetadata: shouldUseRuntimeMetadata({listedModel, modelCount: listedModels.length, runtimeMetadata})
              ? runtimeMetadata
              : null,
            source: 'provider',
          })
        })
  }

  const getHealth = async ({
    apiKey,
    baseURL,
  }: {
    apiKey: string | null
    baseURL: string | null
  }): Promise<ProviderHealthResult> => {
    try {
      const models = await listCompatibleModels({apiKey, baseURL})

      return getProviderHealthSuccess({
        message: getProviderConnectedMessage({catalog, modelCount: models.length}),
        modelCount: models.length,
      })
    } catch (error) {
      return getProviderHealthFailure(error)
    }
  }

  return {
    beginAuth: async ({connection}) => {
      return options.authFlow === 'api-key'
        ? beginApiKeyProviderAuth({catalog, connection, optional: false})
        : options.authFlow === 'optional-api-key'
          ? beginApiKeyProviderAuth({catalog, connection, optional: true})
          : beginSecretlessProviderAuth({catalog, connection})
    },
    catalog,
    finishAuth: async ({connection, payload}) => {
      return options.authFlow === 'api-key'
        ? finishApiKeyProviderAuth({catalog, connection, optional: false, payload})
        : options.authFlow === 'optional-api-key'
          ? finishApiKeyProviderAuth({catalog, connection, optional: true, payload})
          : finishSecretlessProviderAuth({catalog, connection})
    },
    health: async ({runtimeCredentials}) => {
      return getHealth(runtimeCredentials)
    },
    invoke: async ({model, request, runtimeCredentials}: ProviderInvokeInput): Promise<ProviderInvocationResult> => {
      return invokeOpenAIChatModel({
        apiKey: runtimeCredentials.apiKey,
        baseURL: runtimeCredentials.baseURL,
        maxCompletionTokens: request.maxCompletionTokens,
        modelName: getProviderModelName(model),
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        temperature: request.temperature,
      })
    },
    kind: catalog.kind,
    listModels: async ({runtimeCredentials}) => {
      return listCompatibleModels(runtimeCredentials)
    },
    parseUsage: (usage) => {
      return usage
    },
    resolveRuntimeCredentials: async ({connection}) => {
      return options.authFlow === 'api-key' || options.authFlow === 'optional-api-key' || connection.secretRef
        ? resolveApiKeyRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
        : resolveSecretlessRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async ({runtimeCredentials}) => {
      return getHealth(runtimeCredentials)
    },
    transportFamily: options.transportFamily,
  }
}

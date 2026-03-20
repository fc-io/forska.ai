import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {
  type ProviderDefinition,
  type ProviderHealthResult,
  type ProviderInvocationResult,
  type ProviderInvokeInput,
  type ProviderListedModel,
} from '../providerTypes.ts'
import {invokeOpenAIChatModel, listNativeOllamaModels, listOpenAIChatModels} from '../transports/openaiChatTransport.ts'
import {
  getProviderConnectedMessage,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveApiKeyRuntimeCredentials,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

type OpenAICompatibleAdapterOptions = {
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
    if (options.useNativeOllamaDiscovery) {
      try {
        return await listNativeOllamaModels({baseURL})
      } catch {
        return listOpenAIChatModels({apiKey, baseURL, providerLabel: catalog.label})
      }
    }

    return listOpenAIChatModels({apiKey, baseURL, providerLabel: catalog.label})
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
    beginAuth: async () => {
      return {message: `${catalog.label} auth is handled by direct configuration`, payload: null, status: 'unsupported'}
    },
    catalog,
    finishAuth: async () => {
      return {message: `${catalog.label} auth is handled by direct configuration`, payload: null, status: 'unsupported'}
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
      return catalog.requiresApiKey || connection.secretRef
        ? resolveApiKeyRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
        : resolveSecretlessRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async ({runtimeCredentials}) => {
      return getHealth(runtimeCredentials)
    },
    transportFamily: options.transportFamily,
  }
}

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

import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {getNormalizedProviderModelMetadata} from '../providerModelMetadata.ts'
import {type ProviderDefinition} from '../providerTypes.ts'
import {invokeOpenAIResponsesModel, listOpenAIResponseModels} from '../transports/openaiResponsesTransport.ts'
import {
  beginApiKeyProviderAuth,
  finishApiKeyProviderAuth,
  getProviderConnectedMessage,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveApiKeyRuntimeCredentials,
} from './providerAdapterUtils.ts'

export const createOpenAIAdapter = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  const listModels = async ({apiKey, baseURL}: {apiKey: string | null; baseURL: string | null}) => {
    const models = await listOpenAIResponseModels({apiKey, baseURL, providerLabel: catalog.label})

    return models.map((listedModel) => {
      return {
        ...listedModel,
        metadataJson: getNormalizedProviderModelMetadata({
          listedModel,
          providerKind: catalog.kind,
          rawMetadata: listedModel.metadataJson,
          source: 'provider',
        }),
      }
    })
  }

  const getHealth = async ({apiKey, baseURL}: {apiKey: string | null; baseURL: string | null}) => {
    try {
      const models = await listModels({apiKey, baseURL})

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
      return beginApiKeyProviderAuth({catalog, connection, optional: false})
    },
    catalog,
    finishAuth: async ({connection, payload}) => {
      return finishApiKeyProviderAuth({catalog, connection, optional: false, payload})
    },
    health: async ({runtimeCredentials}) => {
      return getHealth(runtimeCredentials)
    },
    invoke: async ({model, request, runtimeCredentials}) => {
      return invokeOpenAIResponsesModel({
        apiKey: runtimeCredentials.apiKey,
        baseURL: runtimeCredentials.baseURL,
        modelName: model.modelName ?? model.remoteModelId ?? model.name,
        outputSchema: request.outputSchema,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        temperature: request.temperature,
      })
    },
    kind: catalog.kind,
    listModels: async ({runtimeCredentials}) => {
      return listModels({apiKey: runtimeCredentials.apiKey, baseURL: runtimeCredentials.baseURL})
    },
    parseUsage: (usage) => {
      return usage
    },
    resolveRuntimeCredentials: async ({connection}) => {
      return resolveApiKeyRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async ({runtimeCredentials}) => {
      return getHealth(runtimeCredentials)
    },
    transportFamily: 'openai-responses',
  }
}

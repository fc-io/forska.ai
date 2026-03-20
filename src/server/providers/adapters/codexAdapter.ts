import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {type ProviderDefinition} from '../providerTypes.ts'
import {getCodexAppHealthResult, invokeCodexAppModel, listCodexAppModels} from '../transports/codexAppTransport.ts'
import {
  getProviderConnectedMessage,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

export const createCodexAdapter = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  const getHealth = async () => {
    const health = await getCodexAppHealthResult()

    if (!health.ok) {
      return health
    }

    try {
      const models = await listCodexAppModels()

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
      return {message: 'Codex auth is handled by the Codex app/CLI flow', payload: null, status: 'unsupported'}
    },
    catalog,
    finishAuth: async () => {
      return {message: 'Codex auth is handled by the Codex app/CLI flow', payload: null, status: 'unsupported'}
    },
    health: async () => {
      return getHealth()
    },
    invoke: async ({model, request}) => {
      return invokeCodexAppModel({
        modelName: model.modelName ?? model.remoteModelId ?? model.name,
        outputSchema: request.outputSchema,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        version: model.variant ?? model.version,
      })
    },
    kind: catalog.kind,
    listModels: async () => {
      return listCodexAppModels()
    },
    parseUsage: (usage) => {
      return usage
    },
    resolveRuntimeCredentials: async ({connection}) => {
      return resolveSecretlessRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async () => {
      return getHealth()
    },
    transportFamily: 'codex-app',
  }
}

import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {getNormalizedProviderModelMetadata} from '../providerModelMetadata.ts'
import {
  type ProviderAuthLifecycleResult,
  type ProviderConnectionRecord,
  type ProviderDefinition,
} from '../providerTypes.ts'
import {
  type ClaudeCodeCliStatus,
  getClaudeCodeCliStatus,
  getClaudeCodeHealthResult,
  invokeClaudeCodeCliModel,
  listClaudeCodeModels,
} from '../transports/claudeCodeCliTransport.ts'
import {
  getProviderConnectedMessage,
  getProviderHealthSuccess,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

const getClaudeCodeAuthResult = ({
  connection,
  status,
}: {
  connection: ProviderConnectionRecord | null
  status: ClaudeCodeCliStatus
}): ProviderAuthLifecycleResult => {
  return {
    connection,
    message: status.message,
    payload: {authMode: 'claude-cli', providerState: status},
    status: status.cliAvailable && status.loggedIn ? 'complete' : 'unsupported',
  }
}

export const createClaudeCodeAdapter = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  const listModels = () => {
    return listClaudeCodeModels().map((listedModel) => {
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

  const getHealth = async () => {
    const health = getClaudeCodeHealthResult(await getClaudeCodeCliStatus())
    const modelCount = listModels().length

    return health.ok
      ? getProviderHealthSuccess({
          message: `${health.message} ${getProviderConnectedMessage({catalog, modelCount})}`,
          modelCount,
        })
      : health
  }

  return {
    beginAuth: async ({connection}) => {
      return getClaudeCodeAuthResult({connection, status: await getClaudeCodeCliStatus()})
    },
    catalog,
    finishAuth: async ({connection}) => {
      return getClaudeCodeAuthResult({connection, status: await getClaudeCodeCliStatus()})
    },
    health: async () => {
      return getHealth()
    },
    invoke: async ({model, request}) => {
      return invokeClaudeCodeCliModel({
        effort: model.variant ?? model.version,
        modelName: model.modelName ?? model.remoteModelId ?? model.name,
        outputSchema: request.outputSchema,
        prompt: request.prompt,
        signal: request.signal,
        systemPrompt: request.systemPrompt,
      })
    },
    kind: catalog.kind,
    listModels: async () => {
      return listModels()
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
    transportFamily: 'claude-code-cli',
  }
}

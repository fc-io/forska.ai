import {
  getFirstEnabledProviderConnection,
  listProviderConnections,
} from '../../providers/providerConnectionRepository.ts'
import {listSelectableProviderModels} from '../../providers/providerModelRepository.ts'
import type {ProviderModelRecord} from '../../providers/providerTypes.ts'
import {isFullTextConversionProvider} from '../../services/providerCatalog.ts'
import {getAnthropicSelectableModels} from './modelsRoutesGetModels/getAnthropicSelectableModels.ts'
import {getCodexVirtualModelsFromServer} from './modelsRoutesGetModels/getCodexVirtualModelsFromServer.ts'
import {getCodexVirtualModelsFromStoredModels} from './modelsRoutesGetModels/getCodexVirtualModelsFromStoredModels.ts'
import {getSelectableStoredModel} from './modelsRoutesGetModels/getSelectableStoredModel.ts'

const getCodexStoredModels = async (): Promise<ProviderModelRecord[]> => {
  const connections = await listProviderConnections()

  return connections.flatMap((connection) => {
    return connection.enabled && connection.providerKind === 'codex' ? connection.models : []
  })
}

const getSelectableModelsPayload = async () => {
  const storedModels = await listSelectableProviderModels()
  const storedCodexModels = await getCodexStoredModels()
  const nonCodexModels = storedModels
    .filter((model) => {
      return (
        model.provider !== 'anthropic' && model.provider !== 'codex' && !isFullTextConversionProvider(model.provider)
      )
    })
    .map(getSelectableStoredModel)
  const anthropicModels = getAnthropicSelectableModels(storedModels)
  const codexConnection = await getFirstEnabledProviderConnection('codex')
  const codexVirtualFromServer = await getCodexVirtualModelsFromServer({
    connection: codexConnection,
    storedModels: storedCodexModels,
  })
  const codexVirtualFromDb = await getCodexVirtualModelsFromStoredModels({
    preferredProviderConnectionId: codexConnection?.id ?? null,
    storedModels: storedCodexModels,
  })
  const codexModels = codexVirtualFromServer.length > 0 ? codexVirtualFromServer : codexVirtualFromDb

  return [...nonCodexModels, ...anthropicModels, ...codexModels]
}

export const modelsRoutesGetModels = async () => {
  return {data: await getSelectableModelsPayload()}
}

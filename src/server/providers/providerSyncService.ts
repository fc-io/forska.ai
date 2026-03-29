import {resolveMatchedProviderRuntimeCredentials} from './providerAuthService.ts'
import {getProviderConnection} from './providerConnectionRepository.ts'
import {setProviderConnectionCheckState} from './providerConnectionRepository.ts'
import {upsertDiscoveredModels} from './providerModelRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {type ProviderConnectionRecord, type ProviderListedModel, type ProviderModelRecord} from './providerTypes.ts'

export type ProviderSyncResult = {
  connection: ProviderConnectionRecord
  discoveredModels: ProviderListedModel[]
  savedModels: ProviderModelRecord[]
}

const getProviderErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

export const syncProviderConnectionModels = async (
  connection: ProviderConnectionRecord,
): Promise<ProviderSyncResult> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = await resolveMatchedProviderRuntimeCredentials(connection)

  try {
    const discoveredModels = await definition.listModels({connection, runtimeCredentials})
    const savedModels = await upsertDiscoveredModels({connection, models: discoveredModels})

    await setProviderConnectionCheckState({id: connection.id, lastError: null})

    return {connection, discoveredModels, savedModels}
  } catch (error) {
    await setProviderConnectionCheckState({id: connection.id, lastError: getProviderErrorMessage(error)})
    throw error
  }
}

export const syncProviderConnectionModelsById = async (connectionId: string): Promise<ProviderSyncResult> => {
  const connection = await getProviderConnection(connectionId)

  if (!connection) {
    throw new Error('Provider connection not found')
  }

  return syncProviderConnectionModels(connection)
}

export const getProviderSyncService = () => {
  return {syncByConnection: syncProviderConnectionModels, syncByConnectionId: syncProviderConnectionModelsById}
}

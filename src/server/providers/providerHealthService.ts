import {resolveProviderRuntimeCredentials} from './providerAuthService.ts'
import {setProviderConnectionCheckState} from './providerConnectionRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {type ProviderConnectionRecord, type ProviderHealthResult} from './providerTypes.ts'

export const getProviderHealth = async (connection: ProviderConnectionRecord): Promise<ProviderHealthResult> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)

  return definition.health({connection, runtimeCredentials})
}

export const testProviderConnectionHealth = async (
  connection: ProviderConnectionRecord,
): Promise<ProviderHealthResult> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = await resolveProviderRuntimeCredentials(connection)
  const result = await definition.testConnection({connection, runtimeCredentials})

  await setProviderConnectionCheckState({id: connection.id, lastError: result.lastError})

  return result
}

export const getProviderHealthService = () => {
  return {getHealth: getProviderHealth, testConnection: testProviderConnectionHealth}
}

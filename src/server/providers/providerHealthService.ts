import {resolveMatchedProviderRuntimeCredentials} from './providerAuthService.ts'
import {setProviderConnectionCheckState} from './providerConnectionRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {type ProviderConnectionRecord, type ProviderHealthResult} from './providerTypes.ts'

export const getProviderHealth = async (connection: ProviderConnectionRecord): Promise<ProviderHealthResult> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = await resolveMatchedProviderRuntimeCredentials(connection)

  return definition.health({connection, runtimeCredentials})
}

export const testProviderConnectionHealth = async (
  connection: ProviderConnectionRecord,
  options?: {effectiveBaseURL?: string | null},
): Promise<ProviderHealthResult> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = await resolveMatchedProviderRuntimeCredentials(connection)
  const result = await definition.testConnection({
    connection,
    runtimeCredentials: {...runtimeCredentials, baseURL: options?.effectiveBaseURL ?? runtimeCredentials.baseURL},
  })

  await setProviderConnectionCheckState({id: connection.id, lastError: result.lastError})

  return result
}

export const getProviderHealthService = () => {
  return {getHealth: getProviderHealth, testConnection: testProviderConnectionHealth}
}

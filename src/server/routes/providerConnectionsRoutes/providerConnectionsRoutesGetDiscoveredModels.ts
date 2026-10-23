import type {Context} from 'elysia'

import {resolveMatchedProviderRuntimeCredentials} from '../../providers/providerAuthService.ts'
import {getProviderConnection} from '../../providers/providerConnectionRepository.ts'
import {requireProviderRegistryEntry} from '../../providers/providerRegistry.ts'
import {getProviderModelWithCapabilities} from '../providerRoutes/providerRoutesShared.ts'

export const providerConnectionsRoutesGetDiscoveredModels = async ({
  params,
  set,
}: {
  params: {id: string}
  set: Context['set']
}) => {
  const connection = await getProviderConnection(params.id)

  if (!connection) {
    set.status = 404
    return {data: null, error: 'Provider connection not found'}
  }

  try {
    const definition = requireProviderRegistryEntry(connection.providerKind)
    const runtimeCredentials = await resolveMatchedProviderRuntimeCredentials(connection)
    const models = await definition.listModels({connection, runtimeCredentials})

    return {
      data: {
        models: models.map((model) => {
          return getProviderModelWithCapabilities({...model, provider: connection.providerKind})
        }),
      },
      error: null,
    }
  } catch (error) {
    set.status = 400
    return {data: null, error: error instanceof Error ? error.message : 'Provider model discovery failed'}
  }
}

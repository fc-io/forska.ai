import {listProviderConnections} from '../../providers/providerConnectionRepository.ts'
import {
  getDetectedProviderRuntimeSummaries,
  getDetectedProviderRuntimeSummary,
} from '../../providers/providerRuntimeDetector.ts'
import {getProviderConnectionWorkerState} from '../../providers/providerRuntimeState.ts'
import {getProviderCatalog} from '../../services/providerCatalog.ts'
import {getProviderModelWithCapabilities, getPublicProviderConnection} from '../providerRoutes/providerRoutesShared.ts'
import {getEffectiveMaxInflightRequests} from './getEffectiveMaxInflightRequests.ts'
import {getSavedModelIds} from './getSavedModelIds.ts'
import {getProviderConnectionRuntimeState} from './providerConnectionsRoutesGetConnections/getProviderConnectionRuntimeState.ts'

const getProviderConnectionsPayload = async () => {
  const connections = await listProviderConnections()
  const runtime = await getDetectedProviderRuntimeSummary()
  const runtimeSummaries = await getDetectedProviderRuntimeSummaries()

  return {
    catalog: getProviderCatalog(),
    connections: connections.map((connection) => {
      return {
        ...getPublicProviderConnection(connection),
        effectiveMaxInflightRequests: getEffectiveMaxInflightRequests(connection),
        models: connection.models.map(getProviderModelWithCapabilities),
        runtimeState: getProviderConnectionRuntimeState({connection, runtimeSummaries}),
        workerState: getProviderConnectionWorkerState({
          baseURL: connection.baseURL,
          config: connection.config,
          providerKind: connection.providerKind,
          runtimeSummary: runtime,
          savedModelIds: getSavedModelIds(connection.models),
        }),
      }
    }),
    runtime,
  }
}

export const providerConnectionsRoutesGetConnections = async () => {
  return {data: await getProviderConnectionsPayload(), error: null}
}

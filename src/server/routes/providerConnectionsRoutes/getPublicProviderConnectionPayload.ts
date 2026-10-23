import {getProviderConnectionWorkerState} from '../../providers/providerRuntimeState.ts'
import {getPublicProviderConnection} from '../providerRoutes/providerRoutesShared.ts'
import {getEffectiveMaxInflightRequests} from './getEffectiveMaxInflightRequests.ts'
import {getSavedModelIds} from './getSavedModelIds.ts'

export const getPublicProviderConnectionPayload = <
  T extends {
    baseURL: string | null
    config: {llamaCppMode?: 'cli' | 'server'; manualWorkerUrls: string[]; workerUrlMode: 'manual' | 'runtime'}
    maxInflightRequests: number | null
    models?: Array<{modelName: string | null; remoteModelId: string | null}>
    providerKind: string
    secretRef: string | null
  },
>(
  connection: T,
) => {
  return {
    ...getPublicProviderConnection(connection),
    effectiveMaxInflightRequests: getEffectiveMaxInflightRequests(connection),
    workerState: getProviderConnectionWorkerState({
      baseURL: connection.baseURL,
      config: connection.config,
      providerKind: connection.providerKind,
      savedModelIds: getSavedModelIds(connection.models ?? []),
    }),
  }
}

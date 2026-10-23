import type {Context} from 'elysia'

import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from '../../providers/providerConnectionHelpers.ts'
import {
  createProviderConnection,
  deleteProviderConnection,
  updateProviderConnection,
} from '../../providers/providerConnectionRepository.ts'
import {storeProviderSecret} from '../../providers/providerSecretStore.ts'
import {getProviderCatalogEntry, isLocalCliProvider, normalizeProviderKind} from '../../services/providerCatalog.ts'
import {
  getProviderConnectionConfig,
  getProviderConnectionLabel,
  getTrimmedValue,
} from '../providerRoutes/providerRoutesShared.ts'
import {getMaxInflightRequests} from './getMaxInflightRequests.ts'
import {getPublicProviderConnectionPayload} from './getPublicProviderConnectionPayload.ts'
import {getSubmittedManualWorkerUrls} from './getSubmittedManualWorkerUrls.ts'

export const providerConnectionsRoutesPostConnection = async ({
  body,
  set,
}: {
  body: {
    apiKey?: string
    baseURL?: string | null
    label?: string
    llamaCppMode?: 'cli' | 'server'
    manualWorkerUrls?: string[]
    maxInflightRequests?: number | null
    providerKind: string
    workerUrls?: string[]
    workerUrlMode?: 'manual' | 'runtime'
  }
  set: Context['set']
}) => {
  const providerKind = normalizeProviderKind(body.providerKind)
  const catalogEntry = getProviderCatalogEntry(providerKind)
  const apiKey = getTrimmedValue(body.apiKey)

  if (providerKind === 'unknown' || !catalogEntry) {
    set.status = 400
    return {data: null, error: 'Unsupported provider'}
  }

  if (catalogEntry.requiresApiKey && !apiKey) {
    set.status = 400
    return {data: null, error: `${catalogEntry.label} API key is required`}
  }

  const baseURL = isLocalCliProvider(providerKind)
    ? null
    : getResolvedProviderBaseURL({baseURL: getTrimmedValue(body.baseURL), providerKind})
  const label = getProviderConnectionLabel({label: body.label, providerKind})
  const config = getProviderConnectionConfig({
    llamaCppMode: getTrimmedValue(body.llamaCppMode),
    manualWorkerUrls: getSubmittedManualWorkerUrls(body),
    providerKind,
    workerUrlMode: getTrimmedValue(body.workerUrlMode),
  })
  const connection = await createProviderConnection({
    authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef: null}),
    baseURL,
    config,
    label,
    maxInflightRequests: getMaxInflightRequests(body.maxInflightRequests),
    providerKind,
    secretRef: null,
  })

  try {
    const secretRef = apiKey ? await storeProviderSecret({connectionId: connection.id, secret: apiKey}) : null
    const savedConnection = secretRef
      ? await updateProviderConnection({
          authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef}),
          baseURL,
          config,
          enabled: connection.enabled,
          id: connection.id,
          label,
          maxInflightRequests: connection.maxInflightRequests,
          secretRef,
        })
      : connection

    return {data: {connection: getPublicProviderConnectionPayload({...savedConnection, models: []})}, error: null}
  } catch (error) {
    await deleteProviderConnection(connection.id).catch(() => {
      return null
    })
    throw error
  }
}

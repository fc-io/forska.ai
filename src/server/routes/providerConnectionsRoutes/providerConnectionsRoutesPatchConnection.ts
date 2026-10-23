import type {Context} from 'elysia'

import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from '../../providers/providerConnectionHelpers.ts'
import {getProviderConnection, updateProviderConnection} from '../../providers/providerConnectionRepository.ts'
import {deleteProviderSecret, storeProviderSecret} from '../../providers/providerSecretStore.ts'
import {isLocalCliProvider} from '../../services/providerCatalog.ts'
import {
  getProviderConnectionConfig,
  getProviderConnectionLabel,
  getTrimmedValue,
} from '../providerRoutes/providerRoutesShared.ts'
import {getMaxInflightRequests} from './getMaxInflightRequests.ts'
import {getPublicProviderConnectionPayload} from './getPublicProviderConnectionPayload.ts'
import {getSubmittedManualWorkerUrls} from './getSubmittedManualWorkerUrls.ts'

export const providerConnectionsRoutesPatchConnection = async ({
  body,
  params,
  set,
}: {
  body: {
    apiKey?: string
    baseURL?: string | null
    clearSecret?: boolean
    enabled?: boolean
    label?: string
    llamaCppMode?: 'cli' | 'server'
    manualWorkerUrls?: string[]
    maxInflightRequests?: number | null
    workerUrls?: string[]
    workerUrlMode?: 'manual' | 'runtime'
  }
  params: {id: string}
  set: Context['set']
}) => {
  const existing = await getProviderConnection(params.id)

  if (!existing) {
    set.status = 404
    return {data: null, error: 'Provider connection not found'}
  }

  const nextBaseURL = isLocalCliProvider(existing.providerKind)
    ? null
    : getResolvedProviderBaseURL({
        baseURL: body.baseURL !== undefined ? getTrimmedValue(body.baseURL) : existing.baseURL,
        providerKind: existing.providerKind,
      })
  const nextLabel = getProviderConnectionLabel({
    label: body.label !== undefined ? body.label : existing.label,
    providerKind: existing.providerKind,
  })
  const nextConfig = getProviderConnectionConfig({
    llamaCppMode: getTrimmedValue(body.llamaCppMode) ?? existing.config.llamaCppMode,
    manualWorkerUrls: getSubmittedManualWorkerUrls(body) ?? existing.config.manualWorkerUrls,
    providerKind: existing.providerKind,
    workerUrlMode: getTrimmedValue(body.workerUrlMode) ?? existing.config.workerUrlMode,
  })
  const shouldClearExistingSecret = body.clearSecret === true
  const nextStoredApiKey = getTrimmedValue(body.apiKey)
  const secretRef = nextStoredApiKey
    ? await storeProviderSecret({connectionId: existing.id, secret: nextStoredApiKey})
    : shouldClearExistingSecret
      ? null
      : existing.secretRef

  try {
    const updated = await updateProviderConnection({
      authMode: getProviderConnectionAuthMode({baseURL: nextBaseURL, providerKind: existing.providerKind, secretRef}),
      baseURL: nextBaseURL,
      config: nextConfig,
      enabled: body.enabled ?? existing.enabled,
      id: existing.id,
      label: nextLabel,
      maxInflightRequests:
        body.maxInflightRequests !== undefined
          ? getMaxInflightRequests(body.maxInflightRequests)
          : existing.maxInflightRequests,
      secretRef,
    })

    if (nextStoredApiKey && existing.secretRef && existing.secretRef !== secretRef) {
      await deleteProviderSecret(existing.secretRef).catch(() => {
        return null
      })
    }

    if (shouldClearExistingSecret && existing.secretRef && existing.secretRef !== secretRef) {
      await deleteProviderSecret(existing.secretRef).catch(() => {
        return null
      })
    }

    return {data: {connection: getPublicProviderConnectionPayload(updated)}, error: null}
  } catch (error) {
    if (nextStoredApiKey && secretRef) {
      await deleteProviderSecret(secretRef).catch(() => {
        return null
      })
    }

    throw error
  }
}

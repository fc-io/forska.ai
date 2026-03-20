import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {readProviderSecret} from '../providerSecretStore.ts'
import {type ProviderHealthResult, type ProviderRuntimeCredentials} from '../providerTypes.ts'

export const getProviderErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

export const getProviderHealthFailure = (error: unknown): ProviderHealthResult => {
  const message = getProviderErrorMessage(error)

  return {lastError: message, message, modelCount: null, ok: false}
}

export const getProviderHealthSuccess = ({
  message,
  modelCount,
}: {
  message: string
  modelCount: number | null
}): ProviderHealthResult => {
  return {lastError: null, message, modelCount, ok: true}
}

export const getProviderConnectedMessage = ({
  catalog,
  modelCount,
}: {
  catalog: ProviderCatalogEntry
  modelCount: number
}): string => {
  return `${catalog.label} connected${modelCount > 0 ? ` (${modelCount} models)` : ''}`
}

export const resolveApiKeyRuntimeCredentials = async ({
  baseURL,
  secretRef,
}: {
  baseURL: string | null
  secretRef: string | null
}): Promise<ProviderRuntimeCredentials> => {
  return {apiKey: await readProviderSecret(secretRef), baseURL, headers: {}, secretRef}
}

export const resolveSecretlessRuntimeCredentials = async ({
  baseURL,
  secretRef,
}: {
  baseURL: string | null
  secretRef: string | null
}): Promise<ProviderRuntimeCredentials> => {
  return {apiKey: null, baseURL, headers: {}, secretRef}
}

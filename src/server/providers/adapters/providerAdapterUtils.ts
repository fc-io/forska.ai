import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {readProviderSecret} from '../providerSecretStore.ts'
import {
  type ProviderAuthField,
  type ProviderAuthLifecyclePayload,
  type ProviderAuthLifecycleResult,
  type ProviderConnectionRecord,
  type ProviderHealthResult,
  type ProviderRuntimeCredentials,
} from '../providerTypes.ts'

const getApiKeyAuthField = ({optional}: {optional: boolean}): ProviderAuthField => {
  return {label: 'API Key', name: 'apiKey', optional, required: !optional, secret: true}
}

const getApiKeyValue = (payload: ProviderAuthLifecyclePayload | null | undefined): string | null => {
  return typeof payload?.secretValue === 'string' && payload.secretValue.trim().length > 0
    ? payload.secretValue.trim()
    : null
}

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

export const beginApiKeyProviderAuth = ({
  catalog,
  connection,
  optional,
}: {
  catalog: ProviderCatalogEntry
  connection: ProviderConnectionRecord | null
  optional: boolean
}): ProviderAuthLifecycleResult => {
  return connection?.hasSecret
    ? {
        connection,
        message: `${catalog.label} credentials are already configured`,
        payload: {authMode: 'api-key', fields: [getApiKeyAuthField({optional})], hasStoredSecret: true},
        status: 'complete',
      }
    : optional
      ? {
          connection,
          message: `${catalog.label} does not require authentication, but you can provide an API key if needed`,
          payload: {authMode: 'none', fields: [getApiKeyAuthField({optional})], hasStoredSecret: false},
          status: 'complete',
        }
      : {
          connection,
          message: `Provide an API key to connect ${catalog.label}`,
          payload: {authMode: 'api-key', fields: [getApiKeyAuthField({optional})], hasStoredSecret: false},
          status: 'pending',
        }
}

export const finishApiKeyProviderAuth = ({
  catalog,
  connection,
  optional,
  payload,
}: {
  catalog: ProviderCatalogEntry
  connection: ProviderConnectionRecord | null
  optional: boolean
  payload: ProviderAuthLifecyclePayload | null | undefined
}): ProviderAuthLifecycleResult => {
  const apiKey = getApiKeyValue(payload)

  if (!apiKey && !optional) {
    throw new Error(`${catalog.label} API key is required`)
  }

  return {
    connection,
    message: apiKey ? `${catalog.label} credentials captured` : `${catalog.label} does not require authentication`,
    payload: {
      authMode: apiKey ? 'api-key' : 'none',
      fields: [getApiKeyAuthField({optional})],
      hasStoredSecret: Boolean(connection?.hasSecret || apiKey),
      secretValue: apiKey,
    },
    status: 'complete',
  }
}

export const beginSecretlessProviderAuth = ({
  catalog,
  connection,
}: {
  catalog: ProviderCatalogEntry
  connection: ProviderConnectionRecord | null
}): ProviderAuthLifecycleResult => {
  return {
    connection,
    message: `${catalog.label} does not require authentication`,
    payload: {authMode: 'none', hasStoredSecret: false},
    status: 'complete',
  }
}

export const finishSecretlessProviderAuth = ({
  catalog,
  connection,
}: {
  catalog: ProviderCatalogEntry
  connection: ProviderConnectionRecord | null
}): ProviderAuthLifecycleResult => {
  return {
    connection,
    message: `${catalog.label} does not require authentication`,
    payload: {authMode: 'none', hasStoredSecret: false, secretValue: null},
    status: 'complete',
  }
}

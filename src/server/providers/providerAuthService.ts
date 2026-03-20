import {type ProviderKind} from '../services/providerCatalog.ts'
import {getProviderConnectionAuthMode} from './providerConnectionHelpers.ts'
import {getProviderConnection, updateProviderConnection} from './providerConnectionRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {deleteProviderSecret, storeProviderSecret} from './providerSecretStore.ts'
import {
  type ProviderAuthLifecyclePayload,
  type ProviderAuthLifecycleResult,
  type ProviderConnectionRecord,
  type ProviderRuntimeCredentials,
} from './providerTypes.ts'

const getUnsupportedAuthLifecycleResult = (providerKind: ProviderKind): ProviderAuthLifecycleResult => {
  return {
    connection: null,
    message: `${providerKind} auth lifecycle is not managed by the provider service yet`,
    payload: null,
    status: 'unsupported',
  }
}

const getPersistedProviderAuthConnection = async ({
  connection,
  payload,
}: {
  connection: ProviderConnectionRecord | null
  payload: ProviderAuthLifecyclePayload | null
}): Promise<ProviderConnectionRecord | null> => {
  if (!connection || !payload) {
    return connection
  }

  const secretValue =
    typeof payload.secretValue === 'string'
      ? payload.secretValue.trim()
      : payload.secretValue === null
        ? null
        : undefined
  const nextSecretRef =
    secretValue === undefined
      ? connection.secretRef
      : secretValue === null
        ? null
        : await storeProviderSecret({connectionId: connection.id, secret: secretValue})

  if (secretValue === null && connection.secretRef) {
    await deleteProviderSecret(connection.secretRef)
  }

  return updateProviderConnection({
    authMode: getProviderConnectionAuthMode({
      baseURL: connection.baseURL,
      providerKind: connection.providerKind,
      secretRef: nextSecretRef,
    }),
    baseURL: connection.baseURL,
    config: connection.config,
    enabled: connection.enabled,
    id: connection.id,
    label: connection.label,
    secretRef: nextSecretRef,
  })
}

export const getProviderAuthConnection = async (
  connectionId: string | null | undefined,
): Promise<ProviderConnectionRecord | null> => {
  return connectionId ? getProviderConnection(connectionId) : null
}

export const beginProviderAuth = async ({
  connection,
  providerKind,
}: {
  connection: ProviderConnectionRecord | null
  providerKind: ProviderKind
}): Promise<ProviderAuthLifecycleResult> => {
  const definition = requireProviderRegistryEntry(providerKind)

  return definition.beginAuth
    ? definition.beginAuth({connection, providerKind})
    : getUnsupportedAuthLifecycleResult(providerKind)
}

export const finishProviderAuth = async ({
  connection,
  payload,
  providerKind,
}: {
  connection: ProviderConnectionRecord | null
  payload: ProviderAuthLifecyclePayload | null
  providerKind: ProviderKind
}): Promise<ProviderAuthLifecycleResult> => {
  const definition = requireProviderRegistryEntry(providerKind)
  const result = definition.finishAuth
    ? await definition.finishAuth({connection, payload, providerKind})
    : getUnsupportedAuthLifecycleResult(providerKind)
  const persistedConnection =
    result.status === 'complete'
      ? await getPersistedProviderAuthConnection({connection, payload: result.payload})
      : connection

  return {...result, connection: persistedConnection}
}

export const resolveProviderRuntimeCredentials = async (
  connection: ProviderConnectionRecord,
): Promise<ProviderRuntimeCredentials> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)

  return definition.resolveRuntimeCredentials({catalog: definition.catalog, connection})
}

export const getProviderAuthService = () => {
  return {
    begin: beginProviderAuth,
    finish: finishProviderAuth,
    resolveRuntimeCredentials: resolveProviderRuntimeCredentials,
  }
}

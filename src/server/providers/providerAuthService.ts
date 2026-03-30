import {type ProviderKind} from '../services/providerCatalog.ts'
import {getProviderConnectionAuthMode} from './providerConnectionHelpers.ts'
import {getProviderConnection, updateProviderConnection} from './providerConnectionRepository.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {markProviderRuntimeUsage} from './providerRuntimeDetector.ts'
import {resolveProviderConnectionRuntimeMatch} from './providerRuntimeMatchResolver.ts'
import {deleteProviderSecret, storeProviderSecret} from './providerSecretStore.ts'
import {
  type ProviderAuthLifecyclePayload,
  type ProviderAuthLifecycleResult,
  type ProviderConnectionRecord,
  type ProviderRuntimeCredentials,
  type ProviderRuntimeMatch,
} from './providerTypes.ts'

const getRuntimeMatchFailureMessage = ({label, match}: {label: string; match: ProviderRuntimeMatch}): string => {
  const targetLabel = match.effectiveBaseURL ? ` at ${match.effectiveBaseURL}` : ''

  return match.status === 'ambiguous'
    ? `${label} runtime selection is ambiguous${targetLabel}. Update the saved base URL or manual worker URLs so exactly one runtime matches this connection.`
    : match.reason === 'runtime-provider-mismatch'
      ? `No active ${label} runtime matches this connection. Start a ${label} runtime or switch the connection to saved manual settings.`
      : match.reason === 'runtime-url-missing'
        ? `${label} runtime auto-detect found an active runtime, but it does not overlap this connection's saved base URL or manual worker URLs. Update the saved URLs or switch the connection to manual settings.`
        : match.reason === 'runtime-worker-missing'
          ? `${label} runtime auto-detect found a runtime without reachable worker URLs. Start the runtime with worker URLs exposed or switch the connection to manual settings.`
          : `No active ${label} runtime matched this connection. Start the runtime or switch the connection to saved manual settings.`
}

const getResolvedProviderRuntimeCredentials = async ({
  connection,
  requireMatchedRuntime,
}: {
  connection: ProviderConnectionRecord
  requireMatchedRuntime: boolean
}): Promise<ProviderRuntimeCredentials> => {
  const definition = requireProviderRegistryEntry(connection.providerKind)
  const runtimeCredentials = await definition.resolveRuntimeCredentials({catalog: definition.catalog, connection})
  const runtimeMatch = await resolveProviderConnectionRuntimeMatch({
    baseURL: runtimeCredentials.baseURL ?? connection.baseURL,
    config: connection.config,
    providerKind: connection.providerKind,
  })

  if (requireMatchedRuntime && runtimeMatch.resolutionMode === 'auto-detect' && runtimeMatch.status !== 'matched') {
    throw new Error(getRuntimeMatchFailureMessage({label: definition.catalog.label, match: runtimeMatch}))
  }

  const baseURL = runtimeMatch.effectiveBaseURL

  markProviderRuntimeUsage({baseURL, providerKind: connection.providerKind})

  return {...runtimeCredentials, baseURL}
}

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
  return getResolvedProviderRuntimeCredentials({connection, requireMatchedRuntime: false})
}

export const resolveMatchedProviderRuntimeCredentials = async (
  connection: ProviderConnectionRecord,
): Promise<ProviderRuntimeCredentials> => {
  return getResolvedProviderRuntimeCredentials({connection, requireMatchedRuntime: true})
}

export const getProviderAuthService = () => {
  return {
    begin: beginProviderAuth,
    finish: finishProviderAuth,
    resolveRuntimeCredentials: resolveProviderRuntimeCredentials,
  }
}

import {type ProviderKind} from '../services/providerCatalog.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {
  type ProviderAuthLifecycleResult,
  type ProviderConnectionRecord,
  type ProviderRuntimeCredentials,
} from './providerTypes.ts'

const getUnsupportedAuthLifecycleResult = (providerKind: ProviderKind): ProviderAuthLifecycleResult => {
  return {
    message: `${providerKind} auth lifecycle is not managed by the provider service yet`,
    payload: null,
    status: 'unsupported',
  }
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
  payload: unknown
  providerKind: ProviderKind
}): Promise<ProviderAuthLifecycleResult> => {
  const definition = requireProviderRegistryEntry(providerKind)

  return definition.finishAuth
    ? definition.finishAuth({connection, payload, providerKind})
    : getUnsupportedAuthLifecycleResult(providerKind)
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

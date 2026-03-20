import {type ProviderKind} from '../services/providerCatalog.ts'
import {
  createProviderConnectionRecord,
  deleteProviderConnectionRecord,
  getFirstEnabledProviderConnectionByKind,
  getProviderConnectionById,
  getProviderConnectionForModel,
  hasEnabledProviderConnection,
  listProviderConnectionsForAdmin,
  setProviderConnectionCheckResult,
  updateProviderConnectionRecord,
} from '../services/providerConnectionQueryService.ts'
import {
  type ProviderConnectionConfig,
  type ProviderConnectionForAdmin,
  type ProviderConnectionRecord,
} from './providerTypes.ts'

export type DeleteProviderConnectionResult = {
  comparisonProjectCount: number
  deletedModelCount: number
  judgmentCount: number
  projectCount: number
}

export const listProviderConnections = async (): Promise<ProviderConnectionForAdmin[]> => {
  return listProviderConnectionsForAdmin()
}

export const getProviderConnection = async (id: string): Promise<ProviderConnectionRecord | null> => {
  return getProviderConnectionById(id)
}

export const getProviderConnectionForStoredModel = async (
  modelId: string,
): Promise<ProviderConnectionRecord | null> => {
  return getProviderConnectionForModel(modelId)
}

export const getFirstEnabledProviderConnection = async (providerKind: ProviderKind) => {
  return getFirstEnabledProviderConnectionByKind(providerKind)
}

export const createProviderConnection = async ({
  authMode,
  baseURL,
  config,
  label,
  providerKind,
  secretRef,
}: {
  authMode: string | null
  baseURL: string | null
  config: ProviderConnectionConfig
  label: string
  providerKind: ProviderKind
  secretRef: string | null
}): Promise<ProviderConnectionRecord> => {
  return createProviderConnectionRecord({authMode, baseURL, config, label, providerKind, secretRef})
}

export const updateProviderConnection = async ({
  authMode,
  baseURL,
  config,
  enabled,
  id,
  label,
  secretRef,
}: {
  authMode: string | null
  baseURL: string | null
  config: ProviderConnectionConfig
  enabled: boolean
  id: string
  label: string
  secretRef: string | null
}): Promise<ProviderConnectionRecord> => {
  return updateProviderConnectionRecord({authMode, baseURL, config, enabled, id, label, secretRef})
}

export const deleteProviderConnection = async (id: string): Promise<DeleteProviderConnectionResult> => {
  return deleteProviderConnectionRecord(id)
}

export const setProviderConnectionCheckState = async ({
  id,
  lastError,
}: {
  id: string
  lastError: string | null
}): Promise<void> => {
  return setProviderConnectionCheckResult({id, lastError})
}

export const hasEnabledProviderConnectionKind = async (providerKind: ProviderKind): Promise<boolean> => {
  return hasEnabledProviderConnection(providerKind)
}

export const getProviderConnectionRepository = () => {
  return {
    create: createProviderConnection,
    delete: deleteProviderConnection,
    getById: getProviderConnection,
    getFirstEnabledByKind: getFirstEnabledProviderConnection,
    getForModel: getProviderConnectionForStoredModel,
    hasEnabledKind: hasEnabledProviderConnectionKind,
    list: listProviderConnections,
    setCheckState: setProviderConnectionCheckState,
    update: updateProviderConnection,
  }
}

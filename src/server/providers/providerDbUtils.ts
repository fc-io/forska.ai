import {type ModelSource} from '../../db/schemaTypes.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from './providerConnectionHelpers.ts'
import {
  type ProviderConnectionConfig,
  type ProviderConnectionForAdmin,
  type ProviderConnectionRecord,
  type ProviderModelRecord,
} from './providerTypes.ts'
import {getDefaultWorkerUrlMode, getWorkerUrlMode, normalizeWorkerUrls} from './providerWorkerUtils.ts'

export type DatabaseRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}
export type DatabaseQueryRunner = Pick<DatabaseRunner, 'queryJson'>

export type ProviderConnectionRow = {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  createdAt: unknown
  enabled: boolean | null
  id: string
  label: string
  lastCheckedAt: unknown
  lastError: string | null
  providerKind: string
  secretRef: string | null
  updatedAt: unknown
}

export type ProviderModelRow = {
  baseURL: string | null
  createdAt: unknown
  displayName: string | null
  enabled: boolean | null
  id: string
  metadataJson: unknown
  modelName: string | null
  name: string
  provider: string | null
  providerConnectionId: string | null
  remoteModelId: string | null
  source: string | null
  updatedAt: unknown
  variant: string | null
  version: string | null
}

export const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const getProviderConnectionConfigFromJson = ({
  providerKind,
  value,
}: {
  providerKind: string | null | undefined
  value: unknown
}): ProviderConnectionConfig => {
  const parsed = getJsonValue(value)
  const manualWorkerUrls =
    typeof parsed === 'object' && parsed !== null && 'manualWorkerUrls' in parsed
      ? normalizeWorkerUrls((parsed as {manualWorkerUrls?: unknown}).manualWorkerUrls as string[] | null | undefined)
      : typeof parsed === 'object' && parsed !== null && 'workerUrls' in parsed
        ? normalizeWorkerUrls((parsed as {workerUrls?: unknown}).workerUrls as string[] | null | undefined)
        : []
  const workerUrlMode =
    typeof parsed === 'object' && parsed !== null && 'workerUrlMode' in parsed
      ? getWorkerUrlMode({
          manualWorkerUrls,
          providerKind,
          workerUrlMode: getTrimmedValue((parsed as {workerUrlMode?: string | null}).workerUrlMode),
        })
      : getDefaultWorkerUrlMode({manualWorkerUrls, providerKind})

  return {manualWorkerUrls, workerUrlMode}
}

export const getPersistedProviderConnectionConfigValue = ({
  config,
  providerKind,
}: {
  config: ProviderConnectionConfig
  providerKind: string | null | undefined
}): ProviderConnectionConfig | null => {
  const manualWorkerUrls = normalizeWorkerUrls(config.manualWorkerUrls)
  const workerUrlMode = getWorkerUrlMode({manualWorkerUrls, providerKind, workerUrlMode: config.workerUrlMode})
  const defaultWorkerUrlMode = getDefaultWorkerUrlMode({manualWorkerUrls, providerKind})

  return manualWorkerUrls.length === 0 && workerUrlMode === defaultWorkerUrlMode && workerUrlMode === 'manual'
    ? null
    : {manualWorkerUrls, workerUrlMode}
}

export const getJsonSqlLiteral = (value: unknown): string => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

export const getProviderConnectionRecordFromRow = (row: ProviderConnectionRow): ProviderConnectionRecord => {
  const providerKind = normalizeProviderKind(row.providerKind)
  const baseURL = getResolvedProviderBaseURL({baseURL: row.baseURL, providerKind})
  const secretRef = getTrimmedValue(row.secretRef)

  return {
    authMode: getTrimmedValue(row.authMode) ?? getProviderConnectionAuthMode({baseURL, providerKind, secretRef}),
    baseURL,
    config: getProviderConnectionConfigFromJson({providerKind, value: row.configJson}),
    createdAt: getDateValue(row.createdAt),
    enabled: row.enabled ?? true,
    hasSecret: Boolean(secretRef),
    id: row.id,
    label: row.label,
    lastCheckedAt: getDateValue(row.lastCheckedAt),
    lastError: getTrimmedValue(row.lastError),
    providerKind,
    secretRef,
    updatedAt: getDateValue(row.updatedAt),
  }
}

export const getProviderModelRecordFromRow = (row: ProviderModelRow): ProviderModelRecord => {
  return {
    baseURL: getTrimmedValue(row.baseURL),
    createdAt: getDateValue(row.createdAt),
    displayName: getTrimmedValue(row.displayName),
    enabled: row.enabled ?? true,
    id: row.id,
    metadataJson: getJsonValue(row.metadataJson),
    modelName: getTrimmedValue(row.modelName),
    name: row.name,
    provider: normalizeProviderKind(row.provider),
    providerConnectionId: getTrimmedValue(row.providerConnectionId),
    remoteModelId: getTrimmedValue(row.remoteModelId),
    source: (getTrimmedValue(row.source) as ModelSource | null) ?? null,
    updatedAt: getDateValue(row.updatedAt),
    variant: getTrimmedValue(row.variant),
    version: getTrimmedValue(row.version),
  }
}

export const attachModelsToConnections = ({
  connections,
  models,
}: {
  connections: ProviderConnectionRecord[]
  models: ProviderModelRecord[]
}): ProviderConnectionForAdmin[] => {
  return connections.map((connection) => {
    return {
      ...connection,
      models: models.filter((model) => {
        return model.providerConnectionId === connection.id
      }),
    }
  })
}

export const getProviderModelReturnQuery = (statement: string): string => {
  return `${statement}
    RETURNING
      id,
      provider_connection_id AS providerConnectionId,
      name,
      NULL AS provider,
      NULL AS baseURL,
      remote_model_id AS modelName,
      remote_model_id AS remoteModelId,
      display_name AS displayName,
      variant AS version,
      variant,
      source,
      enabled,
      TO_JSON(metadata_json) AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
  `
}

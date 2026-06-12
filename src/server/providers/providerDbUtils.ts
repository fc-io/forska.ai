import {type ModelSource} from '../../db/schemaTypes.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {normalizeProviderKind} from '../services/providerCatalog.ts'
import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from './providerConnectionHelpers.ts'
import {
  type ProviderConnectionConfig,
  type ProviderConnectionForAdmin,
  type ProviderConnectionRecord,
  type ProviderLlamaCppMode,
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
  maxInflightRequests: unknown
  providerKind: string
  secretRef: string | null
  updatedAt: unknown
}

export type ProviderModelRow = {
  baseURL: string | null
  connectionConfigJson?: unknown
  createdAt: unknown
  displayName: string | null
  enabled: boolean | null
  id: string
  metadataJson: unknown
  modelName: string | null
  name: string
  provider: string | null
  providerConnectionEnabled?: boolean | null
  providerConnectionId: string | null
  remoteModelId: string | null
  source: string | null
  updatedAt: unknown
  variant: string | null
  version: string | null
}

export const getProviderModelVersionSelectSql = (modelAlias = '') => {
  const prefix = modelAlias === '' ? '' : `${modelAlias}.`

  return `
    CASE
      WHEN json_extract(${prefix}metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model') IS NOT NULL
      THEN json_extract_string(${prefix}metadata_json, '$.projectTransferImportedSnapshot.snapshotFingerprint.model.version')
      ELSE ${prefix}variant
    END
  `
}

export const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getPositiveIntegerValue = (value: unknown): number | null => {
  const numericValue = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(numericValue) && numericValue > 0 ? Math.trunc(numericValue) : null
}

const getLlamaCppMode = ({
  providerKind,
  value,
}: {
  providerKind: string | null | undefined
  value: unknown
}): ProviderLlamaCppMode | undefined => {
  return providerKind === 'llamacpp' && value === 'cli' ? 'cli' : undefined
}

const normalizeModelIds = (value: unknown): string[] => {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value.flatMap((entry) => {
            const normalized = getTrimmedValue(typeof entry === 'string' ? entry : null)

            return normalized ? [normalized] : []
          }),
        ),
      )
    : []
}

const getProjectTransferImportedSnapshot = (value: unknown): Record<string, unknown> | undefined => {
  const parsed = getJsonValue(value)
  const marker =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as {projectTransferImportedSnapshot?: unknown}).projectTransferImportedSnapshot
      : null

  return typeof marker === 'object' && marker !== null && !Array.isArray(marker)
    ? (marker as Record<string, unknown>)
    : undefined
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
  const archived =
    typeof parsed === 'object' && parsed !== null && 'archived' in parsed
      ? Boolean((parsed as {archived?: unknown}).archived)
      : false
  const disabledModelIds =
    typeof parsed === 'object' && parsed !== null && 'disabledModelIds' in parsed
      ? normalizeModelIds((parsed as {disabledModelIds?: unknown}).disabledModelIds)
      : []
  const llamaCppMode =
    typeof parsed === 'object' && parsed !== null && 'llamaCppMode' in parsed
      ? getLlamaCppMode({providerKind, value: (parsed as {llamaCppMode?: unknown}).llamaCppMode})
      : undefined
  const projectTransferImportedSnapshot = getProjectTransferImportedSnapshot(value)
  const importedSnapshotConfig = projectTransferImportedSnapshot === undefined ? {} : {projectTransferImportedSnapshot}
  const config = {archived, disabledModelIds, manualWorkerUrls, ...importedSnapshotConfig, workerUrlMode}

  return llamaCppMode ? {...config, llamaCppMode} : config
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
  const archived = config.archived === true
  const disabledModelIds = normalizeModelIds(config.disabledModelIds)
  const llamaCppMode = getLlamaCppMode({providerKind, value: config.llamaCppMode})
  const projectTransferImportedSnapshot =
    typeof config.projectTransferImportedSnapshot === 'object'
    && config.projectTransferImportedSnapshot !== null
    && !Array.isArray(config.projectTransferImportedSnapshot)
      ? config.projectTransferImportedSnapshot
      : undefined
  const importedSnapshotConfig = projectTransferImportedSnapshot === undefined ? {} : {projectTransferImportedSnapshot}
  const persistedConfig = {archived, disabledModelIds, manualWorkerUrls, ...importedSnapshotConfig, workerUrlMode}

  return !archived
    && disabledModelIds.length === 0
    && !llamaCppMode
    && manualWorkerUrls.length === 0
    && projectTransferImportedSnapshot === undefined
    && workerUrlMode === defaultWorkerUrlMode
    && workerUrlMode === 'manual'
    ? null
    : llamaCppMode
      ? {...persistedConfig, llamaCppMode}
      : persistedConfig
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
    maxInflightRequests: getPositiveIntegerValue(row.maxInflightRequests),
    providerKind,
    secretRef,
    updatedAt: getDateValue(row.updatedAt),
  }
}

export const getProviderModelRecordFromRow = (row: ProviderModelRow): ProviderModelRecord => {
  const providerKind = normalizeProviderKind(row.provider)
  const connectionConfig = getProviderConnectionConfigFromJson({providerKind, value: row.connectionConfigJson})
  const rawEnabled = row.enabled ?? true
  const providerConnectionEnabled = row.providerConnectionEnabled ?? true

  return {
    baseURL: getTrimmedValue(row.baseURL),
    createdAt: getDateValue(row.createdAt),
    displayName: getTrimmedValue(row.displayName),
    enabled:
      rawEnabled
      && providerConnectionEnabled
      && !connectionConfig.archived
      && !connectionConfig.disabledModelIds?.includes(row.id),
    id: row.id,
    metadataJson: getJsonValue(row.metadataJson),
    modelName: getTrimmedValue(row.modelName),
    name: row.name,
    provider: providerKind,
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
      ${getProviderModelVersionSelectSql()} AS version,
      variant,
      source,
      enabled,
      TO_JSON(metadata_json) AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
  `
}

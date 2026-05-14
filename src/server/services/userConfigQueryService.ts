import type {UserRecord} from '../../db/schemaTypes.ts'
import {localUserDefaults} from '../../utils/localUser.ts'
import {getProviderConnectionConfigFromJson} from '../providers/providerDbUtils.ts'
import {getProviderConnectionEffectiveBaseURL} from '../providers/providerRuntimeState.ts'
import {readLocalAppSettings} from '../utils/localAppSettings.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from './appQueryHelpers.ts'

type UserConfigRow = {
  maintenanceWorkerDuckdbMemoryLimit: string | null
  id: string
  name: string
  email: string
  role: string | null
  fullTextConversionModelId: string | null
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildMaxWakeMs: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: string | null
  unpaywallEmail: string | null
  createdAt: unknown
  updatedAt: unknown
}

type FullTextConversionModelConfigRow = {
  baseURL: string | null
  displayName: string | null
  modelId: string
  providerConfigJson: unknown
  providerKind: string | null
  remoteModelId: string | null
}

type FullTextConversionModelAvailabilityRow = Pick<
  FullTextConversionModelConfigRow,
  'modelId' | 'providerConfigJson' | 'providerKind'
>

const userConfigSelectClause = `
  id,
  name,
  email,
  role,
  maintenance_worker_duckdb_memory_limit AS maintenanceWorkerDuckdbMemoryLimit,
  full_text_conversion_model_id AS fullTextConversionModelId,
  project_mart_large_rebuild_batch_size AS projectMartLargeRebuildBatchSize,
  project_mart_large_rebuild_max_cycles_per_wake AS projectMartLargeRebuildMaxCyclesPerWake,
  project_mart_large_rebuild_max_wake_ms AS projectMartLargeRebuildMaxWakeMs,
  project_mart_large_rebuild_poll_interval_ms AS projectMartLargeRebuildPollIntervalMs,
  project_mart_large_rebuild_tuning_mode AS projectMartLargeRebuildTuningMode,
  unpaywall_email AS unpaywallEmail,
  created_at AS createdAt,
  updated_at AS updatedAt
`

const getNullableTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getValueOrFallback = (value: string | null | undefined, fallback: string): string => {
  return getNullableTrimmedValue(value) ?? fallback
}

const getNullablePositiveInteger = (value: number | string | null | undefined): number | null => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const getProjectMartLargeRebuildTuningMode = (
  value: string | null | undefined,
): UserRecord['projectMartLargeRebuildTuningMode'] => {
  return value === 'manual' ? 'manual' : 'automatic'
}

const hasStoredProjectMartLargeRebuildSettings = (
  userConfig: Pick<
    UserRecord,
    | 'maintenanceWorkerDuckdbMemoryLimit'
    | 'projectMartLargeRebuildBatchSize'
    | 'projectMartLargeRebuildMaxCyclesPerWake'
    | 'projectMartLargeRebuildMaxWakeMs'
    | 'projectMartLargeRebuildPollIntervalMs'
    | 'projectMartLargeRebuildTuningMode'
  >,
) => {
  return (
    userConfig.maintenanceWorkerDuckdbMemoryLimit !== null
    || userConfig.projectMartLargeRebuildBatchSize !== null
    || userConfig.projectMartLargeRebuildMaxCyclesPerWake !== null
    || userConfig.projectMartLargeRebuildMaxWakeMs !== null
    || userConfig.projectMartLargeRebuildPollIntervalMs !== null
    || userConfig.projectMartLargeRebuildTuningMode === 'manual'
  )
}

const getDefaultUserRecord = (): UserRecord => {
  const now = new Date()

  return {
    maintenanceWorkerDuckdbMemoryLimit: null,
    id: localUserDefaults.id,
    name: localUserDefaults.name,
    email: localUserDefaults.email,
    role: localUserDefaults.role,
    fullTextConversionModelId: localUserDefaults.fullTextConversionModelId,
    projectMartLargeRebuildBatchSize: null,
    projectMartLargeRebuildMaxCyclesPerWake: null,
    projectMartLargeRebuildMaxWakeMs: null,
    projectMartLargeRebuildPollIntervalMs: null,
    projectMartLargeRebuildTuningMode: 'automatic',
    unpaywallEmail: localUserDefaults.unpaywallEmail,
    createdAt: now,
    updatedAt: now,
  }
}

const getUserConfigValue = (row: UserConfigRow): UserRecord => {
  return {
    maintenanceWorkerDuckdbMemoryLimit: getNullableTrimmedValue(row.maintenanceWorkerDuckdbMemoryLimit),
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    fullTextConversionModelId: row.fullTextConversionModelId,
    projectMartLargeRebuildBatchSize: getNullablePositiveInteger(row.projectMartLargeRebuildBatchSize),
    projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(row.projectMartLargeRebuildMaxCyclesPerWake),
    projectMartLargeRebuildMaxWakeMs: getNullablePositiveInteger(row.projectMartLargeRebuildMaxWakeMs),
    projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(row.projectMartLargeRebuildPollIntervalMs),
    projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(row.projectMartLargeRebuildTuningMode),
    unpaywallEmail: row.unpaywallEmail,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    updatedAt: getDateValue(row.updatedAt) ?? new Date(0),
  }
}

const getUserConfig = async (): Promise<UserRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    SELECT ${userConfigSelectClause}
    FROM app.user_config
    LIMIT 1
  `)

  return row ? getUserConfigValue(row) : null
}

const insertDefaultUserConfig = async (): Promise<UserRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    INSERT INTO app.user_config (
      id,
      name,
      email,
      role,
      maintenance_worker_duckdb_memory_limit,
      full_text_conversion_model_id,
      project_mart_large_rebuild_batch_size,
      project_mart_large_rebuild_max_cycles_per_wake,
      project_mart_large_rebuild_max_wake_ms,
      project_mart_large_rebuild_poll_interval_ms,
      project_mart_large_rebuild_tuning_mode,
      unpaywall_email
    )
    SELECT
      ${getSqlLiteral(localUserDefaults.id)},
      ${getSqlLiteral(localUserDefaults.name)},
      ${getSqlLiteral(localUserDefaults.email)},
      ${getSqlLiteral(localUserDefaults.role)},
      NULL,
      ${getSqlLiteral(localUserDefaults.fullTextConversionModelId)},
      NULL,
      NULL,
      NULL,
      NULL,
      'automatic',
      ${getSqlLiteral(localUserDefaults.unpaywallEmail)}
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.user_config
    )
    RETURNING ${userConfigSelectClause}
  `)

  return row ? getUserConfigValue(row) : null
}

const syncLocalProjectMartLargeRebuildSettings = async (userConfig: UserRecord): Promise<UserRecord> => {
  if (hasStoredProjectMartLargeRebuildSettings(userConfig)) {
    return userConfig
  }

  const localSettings = readLocalAppSettings()
  const hasLocalSettings = hasStoredProjectMartLargeRebuildSettings({
    maintenanceWorkerDuckdbMemoryLimit: localSettings.maintenanceWorkerDuckdbMemoryLimit,
    projectMartLargeRebuildBatchSize: localSettings.projectMartLargeRebuildBatchSize,
    projectMartLargeRebuildMaxCyclesPerWake: localSettings.projectMartLargeRebuildMaxCyclesPerWake,
    projectMartLargeRebuildMaxWakeMs: localSettings.projectMartLargeRebuildMaxWakeMs,
    projectMartLargeRebuildPollIntervalMs: localSettings.projectMartLargeRebuildPollIntervalMs,
    projectMartLargeRebuildTuningMode: localSettings.projectMartLargeRebuildTuningMode,
  })

  if (!hasLocalSettings) {
    return userConfig
  }

  return updateUserConfigRow({
    maintenanceWorkerDuckdbMemoryLimit: localSettings.maintenanceWorkerDuckdbMemoryLimit,
    current: userConfig,
    email: userConfig.email,
    fullTextConversionModelId: userConfig.fullTextConversionModelId,
    name: userConfig.name,
    projectMartLargeRebuildBatchSize: localSettings.projectMartLargeRebuildBatchSize,
    projectMartLargeRebuildMaxCyclesPerWake: localSettings.projectMartLargeRebuildMaxCyclesPerWake,
    projectMartLargeRebuildMaxWakeMs: localSettings.projectMartLargeRebuildMaxWakeMs,
    projectMartLargeRebuildPollIntervalMs: localSettings.projectMartLargeRebuildPollIntervalMs,
    projectMartLargeRebuildTuningMode: localSettings.projectMartLargeRebuildTuningMode,
    unpaywallEmail: userConfig.unpaywallEmail,
  })
}

const getOrCreateUserConfig = async (): Promise<UserRecord> => {
  const existing = await getUserConfig()
  const inserted = existing ? null : await insertDefaultUserConfig()
  const loaded = existing ?? inserted ?? (await getUserConfig())

  return loaded ? syncLocalProjectMartLargeRebuildSettings(loaded) : getDefaultUserRecord()
}

const getFullTextConversionModelAvailability = (row: FullTextConversionModelAvailabilityRow) => {
  const config = getProviderConnectionConfigFromJson({providerKind: row.providerKind, value: row.providerConfigJson})
  const isSelectable = !config.archived && !config.disabledModelIds?.includes(row.modelId)

  return {config, isSelectable}
}

const getValidatedFullTextConversionModelId = async (value: string | null | undefined): Promise<string | null> => {
  const normalizedModelId = getNullableTrimmedValue(value)

  if (!normalizedModelId) {
    return null
  }

  const [row] = await getAppDatabaseService().queryJson<FullTextConversionModelAvailabilityRow>(`
    SELECT
      m.id AS modelId,
      TO_JSON(pc.config_json) AS providerConfigJson,
      pc.provider_kind AS providerKind
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(normalizedModelId)}
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
      AND pc.provider_kind = 'docling'
    LIMIT 1
  `)

  const availability = row ? getFullTextConversionModelAvailability(row) : null

  if (!availability?.isSelectable) {
    throw new Error('Selected PDF conversion model is not available')
  }

  return normalizedModelId
}

const updateUserConfigRow = async ({
  maintenanceWorkerDuckdbMemoryLimit,
  current,
  email,
  fullTextConversionModelId,
  name,
  projectMartLargeRebuildBatchSize,
  projectMartLargeRebuildMaxCyclesPerWake,
  projectMartLargeRebuildMaxWakeMs,
  projectMartLargeRebuildPollIntervalMs,
  projectMartLargeRebuildTuningMode,
  unpaywallEmail,
}: {
  maintenanceWorkerDuckdbMemoryLimit: string | null
  current: UserRecord
  email: string
  fullTextConversionModelId: string | null
  name: string
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildMaxWakeMs: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: UserRecord['projectMartLargeRebuildTuningMode']
  unpaywallEmail: string | null
}): Promise<UserRecord> => {
  const validatedFullTextConversionModelId = await getValidatedFullTextConversionModelId(fullTextConversionModelId)

  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    UPDATE app.user_config
    SET name = ${getSqlLiteral(getValueOrFallback(name, current.name))},
        email = ${getSqlLiteral(getValueOrFallback(email, current.email))},
        maintenance_worker_duckdb_memory_limit = ${getSqlLiteral(getNullableTrimmedValue(maintenanceWorkerDuckdbMemoryLimit))},
        full_text_conversion_model_id = ${getSqlLiteral(validatedFullTextConversionModelId)},
        project_mart_large_rebuild_batch_size = ${getSqlLiteral(getNullablePositiveInteger(projectMartLargeRebuildBatchSize))},
        project_mart_large_rebuild_max_cycles_per_wake = ${getSqlLiteral(getNullablePositiveInteger(projectMartLargeRebuildMaxCyclesPerWake))},
        project_mart_large_rebuild_max_wake_ms = ${getSqlLiteral(getNullablePositiveInteger(projectMartLargeRebuildMaxWakeMs))},
        project_mart_large_rebuild_poll_interval_ms = ${getSqlLiteral(getNullablePositiveInteger(projectMartLargeRebuildPollIntervalMs))},
        project_mart_large_rebuild_tuning_mode = ${getSqlLiteral(getProjectMartLargeRebuildTuningMode(projectMartLargeRebuildTuningMode))},
        unpaywall_email = ${getSqlLiteral(getNullableTrimmedValue(unpaywallEmail))},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(localUserDefaults.id)}
    RETURNING ${userConfigSelectClause}
  `)

  return row ? getUserConfigValue(row) : getOrCreateUserConfig()
}

const updateUserConfig = async ({
  maintenanceWorkerDuckdbMemoryLimit,
  email,
  fullTextConversionModelId,
  name,
  projectMartLargeRebuildBatchSize,
  projectMartLargeRebuildMaxCyclesPerWake,
  projectMartLargeRebuildMaxWakeMs,
  projectMartLargeRebuildPollIntervalMs,
  projectMartLargeRebuildTuningMode,
  unpaywallEmail,
}: {
  maintenanceWorkerDuckdbMemoryLimit: string | null
  email: string
  fullTextConversionModelId: string | null
  name: string
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildMaxWakeMs: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: UserRecord['projectMartLargeRebuildTuningMode']
  unpaywallEmail: string | null
}): Promise<UserRecord> => {
  const current = await getOrCreateUserConfig()

  return updateUserConfigRow({
    maintenanceWorkerDuckdbMemoryLimit,
    current,
    email,
    fullTextConversionModelId,
    name,
    projectMartLargeRebuildBatchSize,
    projectMartLargeRebuildMaxCyclesPerWake,
    projectMartLargeRebuildMaxWakeMs,
    projectMartLargeRebuildPollIntervalMs,
    projectMartLargeRebuildTuningMode,
    unpaywallEmail,
  })
}

const getUnpaywallEmail = async (): Promise<string | null> => {
  const userConfig = await getOrCreateUserConfig()
  const normalized = String(userConfig.unpaywallEmail ?? '').trim()

  return normalized === '' ? null : normalized
}

const getFullTextConversionModelConfig = async (): Promise<{
  baseURL: string
  modelId: string
  modelName: string
  providerKind: string
} | null> => {
  const [row] = await getAppDatabaseService().queryJson<FullTextConversionModelConfigRow>(`
    SELECT
      m.id AS modelId,
      COALESCE(m.display_name, m.remote_model_id, m.name) AS displayName,
      pc.base_url AS baseURL,
      TO_JSON(pc.config_json) AS providerConfigJson,
      pc.provider_kind AS providerKind,
      m.remote_model_id AS remoteModelId
    FROM app.user_config uc
    INNER JOIN app.model m ON m.id = uc.full_text_conversion_model_id
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE pc.provider_kind = 'docling'
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
    LIMIT 1
  `)

  if (!row) {
    return null
  }

  const {config, isSelectable} = getFullTextConversionModelAvailability(row)

  if (!isSelectable) {
    return null
  }

  const baseURL = getProviderConnectionEffectiveBaseURL({baseURL: row.baseURL, config, providerKind: row.providerKind})
  const modelName = getNullableTrimmedValue(row.remoteModelId ?? row.displayName)

  return baseURL && modelName && row.providerKind
    ? {baseURL, modelId: row.modelId, modelName, providerKind: row.providerKind}
    : null
}

export const userConfigQueryService = {
  getFullTextConversionModelConfig,
  getOrCreateUserConfig,
  getUnpaywallEmail,
  updateUserConfig,
}

export const getUserConfigQueryService = () => {
  return userConfigQueryService
}

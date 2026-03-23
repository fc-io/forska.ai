import type {UserRecord} from '../../db/schemaTypes.ts'
import {localUserDefaults} from '../../utils/localUser.ts'
import {getProviderConnectionConfigFromJson} from '../providers/providerDbUtils.ts'
import {getProviderConnectionEffectiveBaseURL} from '../providers/providerRuntimeState.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getSqlLiteral} from './appQueryHelpers.ts'

type UserConfigRow = {
  id: string
  name: string
  email: string
  role: string | null
  fullTextConversionModelId: string | null
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

const userConfigSelectClause = `
  id,
  name,
  email,
  role,
  full_text_conversion_model_id AS fullTextConversionModelId,
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

const getDefaultUserRecord = (): UserRecord => {
  const now = new Date()

  return {
    id: localUserDefaults.id,
    name: localUserDefaults.name,
    email: localUserDefaults.email,
    role: localUserDefaults.role,
    fullTextConversionModelId: localUserDefaults.fullTextConversionModelId,
    unpaywallEmail: localUserDefaults.unpaywallEmail,
    createdAt: now,
    updatedAt: now,
  }
}

const getUserConfigValue = (row: UserConfigRow): UserRecord => {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    fullTextConversionModelId: row.fullTextConversionModelId,
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
      full_text_conversion_model_id,
      unpaywall_email
    )
    SELECT
      ${getSqlLiteral(localUserDefaults.id)},
      ${getSqlLiteral(localUserDefaults.name)},
      ${getSqlLiteral(localUserDefaults.email)},
      ${getSqlLiteral(localUserDefaults.role)},
      ${getSqlLiteral(localUserDefaults.fullTextConversionModelId)},
      ${getSqlLiteral(localUserDefaults.unpaywallEmail)}
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.user_config
    )
    RETURNING ${userConfigSelectClause}
  `)

  return row ? getUserConfigValue(row) : null
}

const getOrCreateUserConfig = async (): Promise<UserRecord> => {
  const existing = await getUserConfig()
  const inserted = existing ? null : await insertDefaultUserConfig()
  const loaded = existing ?? inserted ?? (await getUserConfig())

  return loaded ?? getDefaultUserRecord()
}

const getValidatedFullTextConversionModelId = async (value: string | null | undefined): Promise<string | null> => {
  const normalizedModelId = getNullableTrimmedValue(value)

  if (!normalizedModelId) {
    return null
  }

  const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT m.id AS id
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(normalizedModelId)}
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
      AND pc.provider_kind = 'docling'
    LIMIT 1
  `)

  if (!row) {
    throw new Error('Selected PDF conversion model is not available')
  }

  return normalizedModelId
}

const updateUserConfig = async ({
  email,
  fullTextConversionModelId,
  name,
  unpaywallEmail,
}: {
  email: string
  fullTextConversionModelId: string | null
  name: string
  unpaywallEmail: string | null
}): Promise<UserRecord> => {
  const current = await getOrCreateUserConfig()
  const validatedFullTextConversionModelId = await getValidatedFullTextConversionModelId(fullTextConversionModelId)

  const [row] = await getAppDatabaseService().queryJson<UserConfigRow>(`
    UPDATE app.user_config
    SET name = ${getSqlLiteral(getValueOrFallback(name, current.name))},
        email = ${getSqlLiteral(getValueOrFallback(email, current.email))},
        full_text_conversion_model_id = ${getSqlLiteral(validatedFullTextConversionModelId)},
        unpaywall_email = ${getSqlLiteral(getNullableTrimmedValue(unpaywallEmail))},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(localUserDefaults.id)}
    RETURNING ${userConfigSelectClause}
  `)

  return row ? getUserConfigValue(row) : getOrCreateUserConfig()
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

  const config = getProviderConnectionConfigFromJson({providerKind: row.providerKind, value: row.providerConfigJson})
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

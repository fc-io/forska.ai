import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ProviderKind} from '../services/providerCatalog.ts'
import {
  attachModelsToConnections,
  getJsonSqlLiteral,
  getLegacyProviderConnectionConfig,
  getLegacySecretRef,
  getProviderConnectionRecordFromRow,
  getProviderModelRecordFromRow,
  type ProviderConnectionRow,
  type ProviderModelRow,
} from './providerDbUtils.ts'
import {
  type ProviderConnectionConfig,
  type ProviderConnectionForAdmin,
  type ProviderConnectionRecord,
  type ProviderModelRecord,
} from './providerTypes.ts'

export type DeleteProviderConnectionResult = {
  comparisonProjectCount: number
  deletedModelCount: number
  judgmentCount: number
  projectCount: number
}

const getProviderConnectionRows = async (): Promise<ProviderConnectionRecord[]> => {
  const rows = await getAppDatabaseService().queryJson<ProviderConnectionRow>(`
    SELECT
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      TO_JSON(config_json) AS configJson,
      secret_ref AS secretRef,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.provider_connection
    ORDER BY created_at ASC, label ASC
  `)

  return rows.map(getProviderConnectionRecordFromRow)
}

const getProviderModelRows = async (): Promise<ProviderModelRecord[]> => {
  const rows = await getAppDatabaseService().queryJson<ProviderModelRow>(`
    SELECT
      m.id,
      m.provider_connection_id AS providerConnectionId,
      m.name,
      COALESCE(pc.provider_kind, m.provider) AS provider,
      COALESCE(pc.base_url, m.base_url) AS baseURL,
      COALESCE(m.model_name, m.remote_model_id) AS modelName,
      m.remote_model_id AS remoteModelId,
      COALESCE(m.display_name, m.name) AS displayName,
      m.version,
      m.variant,
      m.source,
      COALESCE(m.enabled, TRUE) AS enabled,
      TO_JSON(m.metadata_json) AS metadataJson,
      m.created_at AS createdAt,
      m.updated_at AS updatedAt
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    ORDER BY COALESCE(pc.label, m.name) ASC, m.created_at ASC, m.name ASC
  `)

  return rows.map(getProviderModelRecordFromRow)
}

const getProviderConnectionRecordById = async (id: string): Promise<ProviderConnectionRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<ProviderConnectionRow>(`
    SELECT
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      TO_JSON(config_json) AS configJson,
      secret_ref AS secretRef,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.provider_connection
    WHERE id = ${getSqlLiteral(id)}
    LIMIT 1
  `)

  return row ? getProviderConnectionRecordFromRow(row) : null
}

const syncModelConnectionFields = async ({
  baseURL,
  providerConnectionId,
  providerKind,
}: {
  baseURL: string | null
  providerConnectionId: string
  providerKind: ProviderKind
}): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.model
    SET provider = ${getSqlLiteral(providerKind)},
        base_url = ${getSqlLiteral(baseURL)},
        updated_at = current_timestamp
    WHERE provider_connection_id = ${getSqlLiteral(providerConnectionId)}
  `)
}

export const listProviderConnections = async (): Promise<ProviderConnectionForAdmin[]> => {
  const [connections, models] = await Promise.all([getProviderConnectionRows(), getProviderModelRows()])

  return attachModelsToConnections({connections, models})
}

export const getProviderConnection = async (id: string): Promise<ProviderConnectionRecord | null> => {
  return getProviderConnectionRecordById(id)
}

export const getProviderConnectionForStoredModel = async (
  modelId: string,
): Promise<ProviderConnectionRecord | null> => {
  const [row] = await getAppDatabaseService().queryJson<
    ProviderConnectionRow & {legacyApiKeyVariable: string | null; legacyWorkerUrls: unknown}
  >(`
    SELECT
      pc.id,
      COALESCE(pc.provider_kind, m.provider) AS providerKind,
      COALESCE(pc.label, m.name) AS label,
      COALESCE(pc.enabled, TRUE) AS enabled,
      COALESCE(pc.auth_mode, CASE WHEN m.api_key_variable IS NOT NULL THEN 'api-key' ELSE NULL END) AS authMode,
      COALESCE(pc.base_url, m.base_url) AS baseURL,
      COALESCE(TO_JSON(pc.config_json), TO_JSON(CASE WHEN m.worker_urls IS NULL THEN NULL ELSE json_object('workerUrls', m.worker_urls) END)) AS configJson,
      COALESCE(pc.secret_ref, ${getSqlLiteral(null)}) AS secretRef,
      pc.last_checked_at AS lastCheckedAt,
      pc.last_error AS lastError,
      COALESCE(pc.created_at, m.created_at) AS createdAt,
      COALESCE(pc.updated_at, m.updated_at) AS updatedAt,
      m.api_key_variable AS legacyApiKeyVariable,
      TO_JSON(m.worker_urls) AS legacyWorkerUrls
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  if (!row) {
    return null
  }

  const mapped = getProviderConnectionRecordFromRow(row)
  const secretRef = mapped.secretRef ?? getLegacySecretRef(row.legacyApiKeyVariable)
  const config =
    mapped.config.workerUrls.length > 0 ? mapped.config : getLegacyProviderConnectionConfig(row.legacyWorkerUrls)

  return {...mapped, config, hasSecret: Boolean(secretRef), secretRef}
}

export const getFirstEnabledProviderConnection = async (providerKind: ProviderKind) => {
  const [row] = await getAppDatabaseService().queryJson<ProviderConnectionRow>(`
    SELECT
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      TO_JSON(config_json) AS configJson,
      secret_ref AS secretRef,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.provider_connection
    WHERE provider_kind = ${getSqlLiteral(providerKind)}
      AND enabled = TRUE
    ORDER BY created_at ASC
    LIMIT 1
  `)

  return row ? getProviderConnectionRecordFromRow(row) : null
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
  const [created] = await getAppDatabaseService().queryJson<ProviderConnectionRow>(`
    INSERT INTO app.provider_connection (
      id,
      provider_kind,
      label,
      enabled,
      auth_mode,
      base_url,
      config_json,
      secret_ref
    )
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(providerKind)},
      ${getSqlLiteral(label)},
      TRUE,
      ${getSqlLiteral(authMode)},
      ${getSqlLiteral(baseURL)},
      ${getJsonSqlLiteral(config)},
      ${getSqlLiteral(secretRef)}
    )
    RETURNING
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      TO_JSON(config_json) AS configJson,
      secret_ref AS secretRef,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)

  if (!created) {
    throw new Error('Failed to create provider connection')
  }

  return getProviderConnectionRecordFromRow(created)
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
  const current = await getProviderConnectionRecordById(id)

  if (!current) {
    throw new Error('Provider connection not found')
  }

  const updated = (await getAppDatabaseService().transaction(async (tx) => {
    const [nextConnection] = await tx.queryJson<ProviderConnectionRow>(`
      UPDATE app.provider_connection
      SET label = ${getSqlLiteral(label)},
          enabled = ${getSqlLiteral(enabled)},
          auth_mode = ${getSqlLiteral(authMode)},
          base_url = ${getSqlLiteral(baseURL)},
          config_json = ${getJsonSqlLiteral(config)},
          secret_ref = ${getSqlLiteral(secretRef)},
          updated_at = current_timestamp
      WHERE id = ${getSqlLiteral(id)}
      RETURNING
        id,
        provider_kind AS providerKind,
        label,
        enabled,
        auth_mode AS authMode,
        base_url AS baseURL,
        TO_JSON(config_json) AS configJson,
        secret_ref AS secretRef,
        last_checked_at AS lastCheckedAt,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
    `)

    if (!nextConnection) {
      throw new Error('Failed to update provider connection')
    }

    return getProviderConnectionRecordFromRow(nextConnection)
  })) as ProviderConnectionRecord

  await syncModelConnectionFields({
    baseURL: updated.baseURL,
    providerConnectionId: updated.id,
    providerKind: updated.providerKind,
  })

  return updated ?? current
}

export const deleteProviderConnection = async (id: string): Promise<DeleteProviderConnectionResult> => {
  const [usage] = await getAppDatabaseService().queryJson<{
    comparisonProjectCount: number
    judgmentCount: number
    modelCount: number
    projectCount: number
  }>(`
    SELECT
      (
        SELECT COUNT(*)
        FROM app.model m
        WHERE m.provider_connection_id = ${getSqlLiteral(id)}
      ) AS modelCount,
      (
        SELECT COUNT(*)
        FROM app.project p
        INNER JOIN app.model m ON p.model_id = m.id
        WHERE m.provider_connection_id = ${getSqlLiteral(id)}
      ) AS projectCount,
      (
        SELECT COUNT(*)
        FROM app.judgment j
        INNER JOIN app.model m ON j.model_id = m.id
        WHERE m.provider_connection_id = ${getSqlLiteral(id)}
      ) AS judgmentCount,
      (
        SELECT COUNT(*)
        FROM app.comparison_project cp
        WHERE EXISTS (
          SELECT 1
          FROM app.model m
          WHERE m.provider_connection_id = ${getSqlLiteral(id)}
            AND list_contains(cp.model_ids, m.id)
        )
      ) AS comparisonProjectCount
  `)

  if (!usage) {
    throw new Error('Provider connection not found')
  }

  if (usage.projectCount > 0 || usage.judgmentCount > 0 || usage.comparisonProjectCount > 0) {
    throw new Error(
      `Cannot remove provider connection while it is referenced by ${usage.projectCount} projects, ${usage.comparisonProjectCount} comparison projects, or ${usage.judgmentCount} judgments.`,
    )
  }

  await getAppDatabaseService().transaction(async (tx) => {
    await tx.run(`
      DELETE FROM app.model
      WHERE provider_connection_id = ${getSqlLiteral(id)}
    `)

    await tx.run(`
      DELETE FROM app.provider_connection
      WHERE id = ${getSqlLiteral(id)}
    `)
  })

  return {
    comparisonProjectCount: usage.comparisonProjectCount,
    deletedModelCount: usage.modelCount,
    judgmentCount: usage.judgmentCount,
    projectCount: usage.projectCount,
  }
}

export const setProviderConnectionCheckState = async ({
  id,
  lastError,
}: {
  id: string
  lastError: string | null
}): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.provider_connection
    SET last_checked_at = current_timestamp,
        last_error = ${getSqlLiteral(lastError)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(id)}
  `)
}

export const hasEnabledProviderConnectionKind = async (providerKind: ProviderKind): Promise<boolean> => {
  const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.provider_connection
    WHERE provider_kind = ${getSqlLiteral(providerKind)}
      AND enabled = TRUE
    LIMIT 1
  `)

  return Boolean(row)
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

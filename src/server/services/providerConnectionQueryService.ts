import {type ModelSource} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {
  getProviderDefaultBaseURL,
  isCodexProvider,
  normalizeProviderKind,
  type ProviderKind,
} from './providerCatalog.ts'

type DatabaseRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
type DatabaseQueryRunner = Pick<DatabaseRunner, 'queryJson'>

type ProviderConnectionRow = {
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

type ProviderModelRow = {
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

export type ProviderConnectionConfig = {workerUrls: string[]}

export type ProviderConnectionRecord = {
  authMode: string | null
  baseURL: string | null
  config: ProviderConnectionConfig
  createdAt: Date | null
  enabled: boolean
  hasSecret: boolean
  id: string
  label: string
  lastCheckedAt: Date | null
  lastError: string | null
  providerKind: ProviderKind
  secretRef: string | null
  updatedAt: Date | null
}

export type ProviderModelRecord = {
  baseURL: string | null
  createdAt: Date | null
  displayName: string | null
  enabled: boolean
  id: string
  metadataJson: unknown
  modelName: string | null
  name: string
  provider: ProviderKind
  providerConnectionId: string | null
  remoteModelId: string | null
  source: ModelSource | null
  updatedAt: Date | null
  variant: string | null
  version: string | null
}

export type ProviderConnectionForAdmin = ProviderConnectionRecord & {models: ProviderModelRecord[]}

export type DiscoveredProviderModel = {
  displayName: string
  metadataJson: unknown
  modelName: string
  remoteModelId: string
  variant: string | null
  version: string | null
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const normalizeWorkerUrls = (workerUrls: string[] | null | undefined): string[] => {
  return Array.from(
    new Set(
      (workerUrls ?? [])
        .map((url) => {
          return String(url).trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )
}

const getProviderConnectionConfig = (value: unknown): ProviderConnectionConfig => {
  const parsed = getJsonValue(value)
  const workerUrls =
    typeof parsed === 'object' && parsed !== null && 'workerUrls' in parsed
      ? normalizeWorkerUrls((parsed as {workerUrls?: unknown}).workerUrls as string[] | null | undefined)
      : []

  return {workerUrls}
}

const getJsonSqlLiteral = (value: unknown): string => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

export const getProviderConnectionAuthMode = ({
  baseURL,
  providerKind,
  secretRef,
}: {
  baseURL: string | null | undefined
  providerKind: string | null | undefined
  secretRef: string | null | undefined
}): string | null => {
  return isCodexProvider(providerKind)
    ? 'codex-cli'
    : getTrimmedValue(secretRef)
      ? 'api-key'
      : getTrimmedValue(baseURL)
        ? 'none'
        : null
}

export const getResolvedProviderBaseURL = ({
  baseURL,
  providerKind,
}: {
  baseURL: string | null | undefined
  providerKind: string | null | undefined
}): string | null => {
  return getTrimmedValue(baseURL) ?? getProviderDefaultBaseURL(providerKind)
}

const getLegacySecretRef = (apiKeyVariable: string | null | undefined): string | null => {
  const normalized = getTrimmedValue(apiKeyVariable)

  return normalized ? `env:${normalized}` : null
}

export const getLegacyProviderConnectionConfig = (workerUrls: unknown): ProviderConnectionConfig => {
  return {workerUrls: normalizeWorkerUrls(getJsonValue(workerUrls) as string[] | null)}
}

const getProviderConnectionRecord = (row: ProviderConnectionRow): ProviderConnectionRecord => {
  const providerKind = normalizeProviderKind(row.providerKind)
  const baseURL = getResolvedProviderBaseURL({baseURL: row.baseURL, providerKind})
  const secretRef = getTrimmedValue(row.secretRef)

  return {
    authMode: getTrimmedValue(row.authMode) ?? getProviderConnectionAuthMode({baseURL, providerKind, secretRef}),
    baseURL,
    config: getProviderConnectionConfig(row.configJson),
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

const getProviderModelRecord = (row: ProviderModelRow): ProviderModelRecord => {
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

  return rows.map(getProviderConnectionRecord)
}

const getProviderModelRows = async ({enabledOnly}: {enabledOnly: boolean}): Promise<ProviderModelRecord[]> => {
  const enabledClause = enabledOnly
    ? `WHERE COALESCE(m.enabled, TRUE) = TRUE
       AND COALESCE(pc.enabled, TRUE) = TRUE`
    : ''
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
    ${enabledClause}
    ORDER BY COALESCE(pc.label, m.name) ASC, m.created_at ASC, m.name ASC
  `)

  return rows.map(getProviderModelRecord)
}

const attachModelsToConnections = ({
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

  return row ? getProviderConnectionRecord(row) : null
}

export const getFirstEnabledProviderConnectionByKind = async (
  providerKind: string,
): Promise<ProviderConnectionRecord | null> => {
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
    WHERE provider_kind = ${getSqlLiteral(normalizeProviderKind(providerKind))}
      AND enabled = TRUE
    ORDER BY created_at ASC
    LIMIT 1
  `)

  return row ? getProviderConnectionRecord(row) : null
}

const syncModelConnectionFields = async (
  databaseRunner: DatabaseRunner,
  {
    baseURL,
    providerConnectionId,
    providerKind,
  }: {baseURL: string | null; providerConnectionId: string; providerKind: ProviderKind},
): Promise<void> => {
  await databaseRunner.run(`
    UPDATE app.model
    SET provider = ${getSqlLiteral(providerKind)},
        base_url = ${getSqlLiteral(baseURL)},
        updated_at = current_timestamp
    WHERE provider_connection_id = ${getSqlLiteral(providerConnectionId)}
  `)
}

const getProviderModelReturnQuery = (statement: string): string => {
  return `${statement}
    RETURNING
      id,
      provider_connection_id AS providerConnectionId,
      name,
      provider,
      base_url AS baseURL,
      model_name AS modelName,
      remote_model_id AS remoteModelId,
      display_name AS displayName,
      version,
      variant,
      source,
      enabled,
      TO_JSON(metadata_json) AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
  `
}

const getExistingProviderModelId = async (
  databaseRunner: DatabaseRunner,
  {
    providerConnectionId,
    remoteModelId,
    variant,
  }: {providerConnectionId: string; remoteModelId: string; variant: string | null},
): Promise<string | null> => {
  const [existing] = await databaseRunner.queryJson<{id: string}>(`
    SELECT id
    FROM app.model
    WHERE provider_connection_id = ${getSqlLiteral(providerConnectionId)}
      AND remote_model_id = ${getSqlLiteral(remoteModelId)}
      AND ${variant ? `variant = ${getSqlLiteral(variant)}` : 'variant IS NULL'}
    LIMIT 1
  `)

  return existing?.id ?? null
}

const upsertDiscoveredProviderModelsRecursively = async (
  databaseRunner: DatabaseRunner,
  {
    connection,
    discoveredModels,
    processed,
  }: {
    connection: ProviderConnectionRecord
    discoveredModels: DiscoveredProviderModel[]
    processed: ProviderModelRecord[]
  },
): Promise<ProviderModelRecord[]> => {
  if (discoveredModels.length === 0) {
    return processed
  }

  const currentModel = discoveredModels[0]
  const rest = discoveredModels.slice(1)

  if (!currentModel) {
    return processed
  }
  const remoteModelId = getTrimmedValue(currentModel.remoteModelId) ?? currentModel.modelName
  const displayName = getTrimmedValue(currentModel.displayName) ?? remoteModelId
  const modelName = getTrimmedValue(currentModel.modelName) ?? remoteModelId
  const variant = getTrimmedValue(currentModel.variant)
  const version = getTrimmedValue(currentModel.version)
  const existingId = await getExistingProviderModelId(databaseRunner, {
    providerConnectionId: connection.id,
    remoteModelId,
    variant,
  })
  const [saved] = await databaseRunner.queryJson<ProviderModelRow>(
    existingId
      ? getProviderModelReturnQuery(`
        UPDATE app.model
        SET name = ${getSqlLiteral(displayName)},
            provider = ${getSqlLiteral(connection.providerKind)},
            base_url = ${getSqlLiteral(connection.baseURL)},
            model_name = ${getSqlLiteral(modelName)},
            remote_model_id = ${getSqlLiteral(remoteModelId)},
            display_name = ${getSqlLiteral(displayName)},
            version = ${getSqlLiteral(version)},
            variant = ${getSqlLiteral(variant)},
            source = 'discovered',
            metadata_json = ${getJsonSqlLiteral(currentModel.metadataJson)},
            updated_at = current_timestamp
        WHERE id = ${getSqlLiteral(existingId)}
      `)
      : getProviderModelReturnQuery(`
        INSERT INTO app.model (
          id,
          provider_connection_id,
          name,
          provider,
          base_url,
          model_name,
          remote_model_id,
          display_name,
          version,
          variant,
          source,
          enabled,
          metadata_json
        )
        VALUES (
          ${getSqlLiteral(crypto.randomUUID())},
          ${getSqlLiteral(connection.id)},
          ${getSqlLiteral(displayName)},
          ${getSqlLiteral(connection.providerKind)},
          ${getSqlLiteral(connection.baseURL)},
          ${getSqlLiteral(modelName)},
          ${getSqlLiteral(remoteModelId)},
          ${getSqlLiteral(displayName)},
          ${getSqlLiteral(version)},
          ${getSqlLiteral(variant)},
          'discovered',
          TRUE,
          ${getJsonSqlLiteral(currentModel.metadataJson)}
        )
      `),
  )

  return upsertDiscoveredProviderModelsRecursively(databaseRunner, {
    connection,
    discoveredModels: rest,
    processed: saved ? [...processed, getProviderModelRecord(saved)] : processed,
  })
}

export const listProviderConnectionsForAdmin = async (): Promise<ProviderConnectionForAdmin[]> => {
  const [connections, models] = await Promise.all([
    getProviderConnectionRows(),
    getProviderModelRows({enabledOnly: false}),
  ])

  return attachModelsToConnections({connections, models})
}

export const getProviderConnectionById = async (id: string): Promise<ProviderConnectionRecord | null> => {
  return getProviderConnectionRecordById(id)
}

export const createProviderConnectionRecord = async ({
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

  return getProviderConnectionRecord(created)
}

export const updateProviderConnectionRecord = async ({
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

    const mappedConnection = getProviderConnectionRecord(nextConnection)

    await syncModelConnectionFields(tx, {
      baseURL: mappedConnection.baseURL,
      providerConnectionId: mappedConnection.id,
      providerKind: mappedConnection.providerKind,
    })

    return mappedConnection
  })) as ProviderConnectionRecord

  return updated ?? current
}

export const setProviderConnectionCheckResult = async ({
  id,
  lastError,
}: {
  id: string
  lastError: string | null
}): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.provider_connection
    SET last_checked_at = current_timestamp,
        last_error = ${getSqlLiteral(getTrimmedValue(lastError))},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(id)}
  `)
}

export const createProviderModelRecord = async ({
  connection,
  displayName,
  metadataJson,
  modelName,
  remoteModelId,
  source,
  variant,
  version,
}: {
  connection: ProviderConnectionRecord
  displayName: string
  metadataJson: unknown
  modelName: string
  remoteModelId: string
  source: ModelSource
  variant: string | null
  version: string | null
}): Promise<ProviderModelRecord> => {
  const [created] = await getAppDatabaseService().queryJson<ProviderModelRow>(
    getProviderModelReturnQuery(`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        provider,
        base_url,
        model_name,
        remote_model_id,
        display_name,
        version,
        variant,
        source,
        enabled,
        metadata_json
      )
      VALUES (
        ${getSqlLiteral(crypto.randomUUID())},
        ${getSqlLiteral(connection.id)},
        ${getSqlLiteral(displayName)},
        ${getSqlLiteral(connection.providerKind)},
        ${getSqlLiteral(connection.baseURL)},
        ${getSqlLiteral(modelName)},
        ${getSqlLiteral(remoteModelId)},
        ${getSqlLiteral(displayName)},
        ${getSqlLiteral(version)},
        ${getSqlLiteral(variant)},
        ${getSqlLiteral(source)},
        TRUE,
        ${getJsonSqlLiteral(metadataJson)}
      )
    `),
  )

  if (!created) {
    throw new Error('Failed to create provider model')
  }

  return getProviderModelRecord(created)
}

export const upsertDiscoveredProviderModels = async ({
  connection,
  discoveredModels,
}: {
  connection: ProviderConnectionRecord
  discoveredModels: DiscoveredProviderModel[]
}): Promise<ProviderModelRecord[]> => {
  return (await getAppDatabaseService().transaction(async (tx) => {
    return upsertDiscoveredProviderModelsRecursively(tx, {connection, discoveredModels, processed: []})
  })) as ProviderModelRecord[]
}

export const updateProviderModelRecord = async ({
  displayName,
  enabled,
  id,
  variant,
}: {
  displayName: string
  enabled: boolean
  id: string
  variant: string | null
}): Promise<ProviderModelRecord> => {
  const [updated] = await getAppDatabaseService().queryJson<ProviderModelRow>(
    getProviderModelReturnQuery(`
      UPDATE app.model
      SET name = ${getSqlLiteral(displayName)},
          display_name = ${getSqlLiteral(displayName)},
          enabled = ${getSqlLiteral(enabled)},
          variant = ${getSqlLiteral(variant)},
          version = ${getSqlLiteral(variant)},
          updated_at = current_timestamp
      WHERE id = ${getSqlLiteral(id)}
    `),
  )

  if (!updated) {
    throw new Error('Provider model not found')
  }

  return getProviderModelRecord(updated)
}

export const listSelectableModels = async (): Promise<ProviderModelRecord[]> => {
  return getProviderModelRows({enabledOnly: true})
}

export const hasEnabledProviderConnection = async (providerKind: string): Promise<boolean> => {
  return Boolean(await getFirstEnabledProviderConnectionByKind(providerKind))
}

export const deleteProviderConnectionRecord = async (
  id: string,
): Promise<{
  deletedModelCount: number
  judgmentCount: number
  projectCount: number
  comparisonProjectCount: number
}> => {
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

export const assertSelectableModelIds = async (
  databaseRunner: DatabaseQueryRunner,
  {errorMessage, modelIds}: {errorMessage: string; modelIds: string[]},
): Promise<string[]> => {
  if (modelIds.length === 0) {
    return modelIds
  }

  const rows = await databaseRunner.queryJson<{id: string}>(`
    SELECT m.id AS id
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id IN (${getQuotedStringList(modelIds).join(', ')})
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
  `)

  if (rows.length !== modelIds.length) {
    throw new Error(errorMessage)
  }

  return modelIds
}

export const assertSelectableModelId = async (
  databaseRunner: DatabaseQueryRunner,
  {errorMessage, modelId}: {errorMessage: string; modelId: string},
): Promise<string> => {
  const [validatedModelId] = await assertSelectableModelIds(databaseRunner, {errorMessage, modelIds: [modelId]})

  if (!validatedModelId) {
    throw new Error(errorMessage)
  }

  return validatedModelId
}

export const getProviderConnectionForModel = async (modelId: string): Promise<ProviderConnectionRecord | null> => {
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

  const mapped = getProviderConnectionRecord(row)
  const secretRef = mapped.secretRef ?? getLegacySecretRef(row.legacyApiKeyVariable)
  const config =
    mapped.config.workerUrls.length > 0 ? mapped.config : getLegacyProviderConnectionConfig(row.legacyWorkerUrls)

  return {
    ...mapped,
    authMode: getProviderConnectionAuthMode({baseURL: mapped.baseURL, providerKind: mapped.providerKind, secretRef}),
    config,
    hasSecret: Boolean(secretRef),
    secretRef,
  }
}

export const getProviderModelsByIds = async (modelIds: string[]): Promise<Map<string, ProviderModelRecord>> => {
  if (modelIds.length === 0) {
    return new Map()
  }

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
    WHERE m.id IN (${getQuotedStringList(modelIds).join(', ')})
  `)

  return new Map(
    rows.map((row) => {
      return [row.id, getProviderModelRecord(row)]
    }),
  )
}

export const getProviderConnectionQueryService = () => {
  return {
    assertSelectableModelId,
    assertSelectableModelIds,
    createProviderConnectionRecord,
    createProviderModelRecord,
    deleteProviderConnectionRecord,
    getFirstEnabledProviderConnectionByKind,
    getProviderConnectionById,
    getProviderConnectionForModel,
    getProviderModelsByIds,
    hasEnabledProviderConnection,
    listProviderConnectionsForAdmin,
    listSelectableModels,
    setProviderConnectionCheckResult,
    updateProviderConnectionRecord,
    updateProviderModelRecord,
    upsertDiscoveredProviderModels,
  }
}

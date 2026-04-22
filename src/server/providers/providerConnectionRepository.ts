import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getProviderCatalogEntry, type ProviderKind} from '../services/providerCatalog.ts'
import {
  attachModelsToConnections,
  type DatabaseRunner,
  getJsonSqlLiteral,
  getPersistedProviderConnectionConfigValue,
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
  archived: boolean
  comparisonProjectCount: number
  deleted: boolean
  deletedModelCount: number
  judgmentCount: number
  projectCount: number
}

type ProviderConnectionDeleteTarget = {connectionIds: string[]; providerKind: ProviderKind}
type ProviderConnectionUsage = {
  comparisonProjectCount: number
  judgmentCount: number
  modelCount: number
  projectCount: number
}
type DeleteProviderConnectionOptions = {afterModelCleanup?: () => Promise<void>}

const isArchivedProviderConnection = (connection: ProviderConnectionRecord): boolean => {
  return connection.config.archived === true
}

const isSingletonProviderKind = (providerKind: ProviderKind): boolean => {
  return providerKind === 'codex'
}

const getProviderConnectionRowsByKind = async (providerKind: ProviderKind): Promise<ProviderConnectionRow[]> => {
  return getAppDatabaseService().queryJson<ProviderConnectionRow>(`
    SELECT
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      max_inflight_requests AS maxInflightRequests,
      TO_JSON(config_json) AS configJson,
      secret_ref AS secretRef,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.provider_connection
    WHERE provider_kind = ${getSqlLiteral(providerKind)}
    ORDER BY created_at ASC, label ASC
  `)
}

const getVisibleProviderConnections = (connections: ProviderConnectionRecord[]): ProviderConnectionRecord[] => {
  return connections.filter((connection) => {
    return !isArchivedProviderConnection(connection)
  })
}

const getCollapsedProviderConnections = (connections: ProviderConnectionForAdmin[]): ProviderConnectionForAdmin[] => {
  return connections
    .filter((connection, _index, connectionList) => {
      return (
        !isSingletonProviderKind(connection.providerKind)
        || connectionList.find((candidate) => {
          return candidate.providerKind === connection.providerKind
        })?.id === connection.id
      )
    })
    .map((connection) => {
      return isSingletonProviderKind(connection.providerKind)
        ? {
            ...connection,
            label: getProviderCatalogEntry(connection.providerKind)?.label ?? connection.label,
            models: connections.flatMap((candidate) => {
              return candidate.providerKind === connection.providerKind ? candidate.models : []
            }),
          }
        : connection
    })
}

const getSingletonProviderConnection = async (providerKind: ProviderKind): Promise<ProviderConnectionRecord | null> => {
  if (!isSingletonProviderKind(providerKind)) {
    return null
  }

  const canonicalConnection = getVisibleProviderConnections(
    (await getProviderConnectionRowsByKind(providerKind)).map(getProviderConnectionRecordFromRow),
  )[0]

  if (!canonicalConnection) {
    return null
  }

  return canonicalConnection
}

const getProviderConnectionDeleteTarget = async (id: string): Promise<ProviderConnectionDeleteTarget> => {
  const connection = await getProviderConnection(id)

  if (!connection) {
    throw new Error('Provider connection not found')
  }

  if (!isSingletonProviderKind(connection.providerKind)) {
    return {connectionIds: [id], providerKind: connection.providerKind}
  }

  const visibleConnectionIds = getVisibleProviderConnections(
    (await getProviderConnectionRowsByKind(connection.providerKind)).map(getProviderConnectionRecordFromRow),
  ).map((row) => {
    return row.id
  })

  return {
    connectionIds: visibleConnectionIds.length > 0 ? visibleConnectionIds : [id],
    providerKind: connection.providerKind,
  }
}

const getProviderConnectionUsage = async (
  databaseRunner: DatabaseRunner,
  connectionIds: string[],
): Promise<ProviderConnectionUsage | null> => {
  const connectionIdsSql = getQuotedStringList(connectionIds).join(', ')
  const [usage] = await databaseRunner.queryJson<ProviderConnectionUsage>(`
    SELECT
      (
        SELECT COUNT(*)
        FROM app.model m
        WHERE m.provider_connection_id IN (${connectionIdsSql})
      ) AS modelCount,
      (
        SELECT COUNT(*)
        FROM app.project p
        INNER JOIN app.model m ON p.model_id = m.id
        WHERE m.provider_connection_id IN (${connectionIdsSql})
      ) AS projectCount,
      (
        SELECT COUNT(*)
        FROM app.judgment j
        INNER JOIN app.model m ON j.model_id = m.id
        WHERE m.provider_connection_id IN (${connectionIdsSql})
      ) AS judgmentCount,
      (
        SELECT COUNT(*)
        FROM app.comparison_project cp
        WHERE EXISTS (
          SELECT 1
          FROM app.model m
          WHERE m.provider_connection_id IN (${connectionIdsSql})
            AND list_contains(cp.model_ids, m.id)
        )
      ) AS comparisonProjectCount
  `)

  return usage ?? null
}

const getProviderConnectionRecordsByIds = async (
  databaseRunner: DatabaseRunner,
  connectionIds: string[],
): Promise<ProviderConnectionRecord[]> => {
  const connectionIdsSql = getQuotedStringList(connectionIds).join(', ')
  const rows = await databaseRunner.queryJson<ProviderConnectionRow>(`
    SELECT
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      max_inflight_requests AS maxInflightRequests,
      TO_JSON(config_json) AS configJson,
      secret_ref AS secretRef,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.provider_connection
    WHERE id IN (${connectionIdsSql})
  `)

  return rows.map(getProviderConnectionRecordFromRow)
}

const hasProviderConnectionDeleteUsage = (usage: ProviderConnectionUsage): boolean => {
  return usage.projectCount > 0 || usage.judgmentCount > 0 || usage.comparisonProjectCount > 0
}

const getArchivedDeleteResult = (usage: ProviderConnectionUsage): DeleteProviderConnectionResult => {
  return {
    archived: true,
    comparisonProjectCount: usage.comparisonProjectCount,
    deleted: false,
    deletedModelCount: usage.modelCount,
    judgmentCount: usage.judgmentCount,
    projectCount: usage.projectCount,
  }
}

const getDeletedDeleteResult = (usage: ProviderConnectionUsage): DeleteProviderConnectionResult => {
  return {
    archived: false,
    comparisonProjectCount: usage.comparisonProjectCount,
    deleted: true,
    deletedModelCount: usage.modelCount,
    judgmentCount: usage.judgmentCount,
    projectCount: usage.projectCount,
  }
}

const archiveProviderConnections = async (
  databaseRunner: DatabaseRunner,
  {connectionIds, providerKind}: ProviderConnectionDeleteTarget,
  {afterModelCleanup}: DeleteProviderConnectionOptions = {},
): Promise<void> => {
  const connections = await getProviderConnectionRecordsByIds(databaseRunner, connectionIds)

  if (connections.length !== connectionIds.length) {
    throw new Error('Provider connection not found')
  }

  const connectionIdsSql = getQuotedStringList(connectionIds).join(', ')
  const configCaseSql = connections
    .map((connection) => {
      const persistedConfig = getPersistedProviderConnectionConfigValue({
        config: {...connection.config, archived: true},
        providerKind,
      })

      return `WHEN ${getSqlLiteral(connection.id)} THEN ${getJsonSqlLiteral(persistedConfig)}`
    })
    .join(' ')

  await databaseRunner.run(`
    UPDATE app.model
    SET enabled = FALSE,
        updated_at = current_timestamp
    WHERE provider_connection_id IN (${connectionIdsSql})
  `)

  await afterModelCleanup?.()

  await databaseRunner.run(`
    UPDATE app.provider_connection
    SET enabled = FALSE,
        config_json = CASE id ${configCaseSql} ELSE config_json END,
        updated_at = current_timestamp
    WHERE id IN (${connectionIdsSql})
  `)
}

const deleteProviderConnections = async (
  databaseRunner: DatabaseRunner,
  connectionIds: string[],
  {afterModelCleanup}: DeleteProviderConnectionOptions = {},
): Promise<void> => {
  const connectionIdsSql = getQuotedStringList(connectionIds).join(', ')

  await databaseRunner.run(`
    DELETE FROM app.model
    WHERE provider_connection_id IN (${connectionIdsSql})
  `)

  await afterModelCleanup?.()

  await databaseRunner.run(`
    DELETE FROM app.provider_connection
    WHERE id IN (${connectionIdsSql})
  `)
}

const isForeignKeyConstraintError = (error: unknown): boolean => {
  const errorMessage = error instanceof Error ? error.message : String(error)

  return errorMessage.toLowerCase().includes('foreign key constraint')
}

const deleteProviderConnectionWithFallback = async (
  deleteTarget: ProviderConnectionDeleteTarget,
  options: DeleteProviderConnectionOptions = {},
): Promise<DeleteProviderConnectionResult> => {
  try {
    return (await getAppDatabaseService().transaction(async (databaseRunner) => {
      const usage = await getProviderConnectionUsage(databaseRunner, deleteTarget.connectionIds)

      if (!usage) {
        throw new Error('Provider connection not found')
      }

      if (hasProviderConnectionDeleteUsage(usage)) {
        await archiveProviderConnections(databaseRunner, deleteTarget, options)

        return getArchivedDeleteResult(usage)
      }

      await deleteProviderConnections(databaseRunner, deleteTarget.connectionIds, options)

      return getDeletedDeleteResult(usage)
    })) as DeleteProviderConnectionResult
  } catch (error) {
    if (!isForeignKeyConstraintError(error)) {
      throw error
    }

    return (await getAppDatabaseService().transaction(async (databaseRunner) => {
      const usage = await getProviderConnectionUsage(databaseRunner, deleteTarget.connectionIds)

      if (!usage) {
        throw new Error('Provider connection not found')
      }

      await archiveProviderConnections(databaseRunner, deleteTarget)

      return getArchivedDeleteResult(usage)
    })) as DeleteProviderConnectionResult
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
      max_inflight_requests AS maxInflightRequests,
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
      pc.provider_kind AS provider,
      pc.base_url AS baseURL,
      TO_JSON(pc.config_json) AS connectionConfigJson,
      pc.enabled AS providerConnectionEnabled,
      m.remote_model_id AS modelName,
      m.remote_model_id AS remoteModelId,
      COALESCE(m.display_name, m.name) AS displayName,
      m.variant AS version,
      m.variant,
      m.source,
      COALESCE(m.enabled, TRUE) AS enabled,
      TO_JSON(m.metadata_json) AS metadataJson,
      m.created_at AS createdAt,
      m.updated_at AS updatedAt
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
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

export const listProviderConnections = async (): Promise<ProviderConnectionForAdmin[]> => {
  const [connections, models] = await Promise.all([getProviderConnectionRows(), getProviderModelRows()])

  return getCollapsedProviderConnections(
    attachModelsToConnections({connections: getVisibleProviderConnections(connections), models}),
  )
}

export const getProviderConnection = async (id: string): Promise<ProviderConnectionRecord | null> => {
  return getProviderConnectionRecordById(id)
}

export const getProviderConnectionForStoredModel = async (
  modelId: string,
  databaseRunner: DatabaseRunner = getAppDatabaseService(),
): Promise<ProviderConnectionRecord | null> => {
  const [row] = await databaseRunner.queryJson<ProviderConnectionRow>(`
    SELECT
      pc.id,
      pc.provider_kind AS providerKind,
      pc.label AS label,
      pc.enabled AS enabled,
      pc.auth_mode AS authMode,
      pc.base_url AS baseURL,
      pc.max_inflight_requests AS maxInflightRequests,
      TO_JSON(pc.config_json) AS configJson,
      pc.secret_ref AS secretRef,
      pc.last_checked_at AS lastCheckedAt,
      pc.last_error AS lastError,
      pc.created_at AS createdAt,
      pc.updated_at AS updatedAt
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  if (!row) {
    return null
  }

  return getProviderConnectionRecordFromRow(row)
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
      max_inflight_requests AS maxInflightRequests,
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
  maxInflightRequests,
  providerKind,
  secretRef,
}: {
  authMode: string | null
  baseURL: string | null
  config: ProviderConnectionConfig
  label: string
  maxInflightRequests: number | null
  providerKind: ProviderKind
  secretRef: string | null
}): Promise<ProviderConnectionRecord> => {
  const singletonConnection = isSingletonProviderKind(providerKind)
    ? await getSingletonProviderConnection(providerKind)
    : null

  if (singletonConnection) {
    return singletonConnection
  }

  const persistedConfig = getPersistedProviderConnectionConfigValue({config, providerKind})
  const [created] = await getAppDatabaseService().queryJson<ProviderConnectionRow>(`
    INSERT INTO app.provider_connection (
      id,
      provider_kind,
      label,
      enabled,
      auth_mode,
      base_url,
      max_inflight_requests,
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
      ${getSqlLiteral(maxInflightRequests)},
      ${getJsonSqlLiteral(persistedConfig)},
      ${getSqlLiteral(secretRef)}
    )
    RETURNING
      id,
      provider_kind AS providerKind,
      label,
      enabled,
      auth_mode AS authMode,
      base_url AS baseURL,
      max_inflight_requests AS maxInflightRequests,
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
  maxInflightRequests,
  secretRef,
}: {
  authMode: string | null
  baseURL: string | null
  config: ProviderConnectionConfig
  enabled: boolean
  id: string
  label: string
  maxInflightRequests: number | null
  secretRef: string | null
}): Promise<ProviderConnectionRecord> => {
  const current = await getProviderConnectionRecordById(id)

  if (!current) {
    throw new Error('Provider connection not found')
  }

  const persistedConfig = getPersistedProviderConnectionConfigValue({config, providerKind: current.providerKind})
  const updated = (await getAppDatabaseService().transaction(async (tx) => {
    const [nextConnection] = await tx.queryJson<ProviderConnectionRow>(`
      UPDATE app.provider_connection
      SET label = ${getSqlLiteral(label)},
          enabled = ${getSqlLiteral(enabled)},
          auth_mode = ${getSqlLiteral(authMode)},
          base_url = ${getSqlLiteral(baseURL)},
          max_inflight_requests = ${getSqlLiteral(maxInflightRequests)},
          config_json = ${getJsonSqlLiteral(persistedConfig)},
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
        max_inflight_requests AS maxInflightRequests,
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

  return updated ?? current
}

export const deleteProviderConnection = async (
  id: string,
  options: DeleteProviderConnectionOptions = {},
): Promise<DeleteProviderConnectionResult> => {
  const deleteTarget = await getProviderConnectionDeleteTarget(id)

  return deleteProviderConnectionWithFallback(deleteTarget, options)
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

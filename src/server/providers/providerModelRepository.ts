import {type ModelSource} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  type DatabaseQueryRunner,
  getJsonSqlLiteral,
  getProviderModelRecordFromRow,
  getProviderModelReturnQuery,
  type ProviderModelRow,
} from './providerDbUtils.ts'
import {type ProviderConnectionRecord, type ProviderListedModel, type ProviderModelRecord} from './providerTypes.ts'

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

  return rows.map(getProviderModelRecordFromRow)
}

const getExistingProviderModelId = async ({
  providerConnectionId,
  remoteModelId,
  variant,
}: {
  providerConnectionId: string
  remoteModelId: string
  variant: string | null
}): Promise<string | null> => {
  const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.model
    WHERE provider_connection_id = ${getSqlLiteral(providerConnectionId)}
      AND remote_model_id = ${getSqlLiteral(remoteModelId)}
      AND ${variant ? `variant = ${getSqlLiteral(variant)}` : 'variant IS NULL'}
    LIMIT 1
  `)

  return existing?.id ?? null
}

const upsertDiscoveredProviderModelsRecursively = async ({
  connection,
  discoveredModels,
  processed,
}: {
  connection: ProviderConnectionRecord
  discoveredModels: ProviderListedModel[]
  processed: ProviderModelRecord[]
}): Promise<ProviderModelRecord[]> => {
  if (discoveredModels.length === 0) {
    return processed
  }

  const currentModel = discoveredModels[0]
  const rest = discoveredModels.slice(1)

  if (!currentModel) {
    return processed
  }

  const remoteModelId = currentModel.remoteModelId
  const displayName = currentModel.displayName
  const modelName = currentModel.modelName
  const variant = currentModel.variant
  const version = currentModel.version
  const existingId = await getExistingProviderModelId({providerConnectionId: connection.id, remoteModelId, variant})
  const [saved] = await getAppDatabaseService().queryJson<ProviderModelRow>(
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

  return upsertDiscoveredProviderModelsRecursively({
    connection,
    discoveredModels: rest,
    processed: saved ? [...processed, getProviderModelRecordFromRow(saved)] : processed,
  })
}

export const listSelectableProviderModels = async (): Promise<ProviderModelRecord[]> => {
  return getProviderModelRows({enabledOnly: true})
}

export const createProviderModel = async ({
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

  return getProviderModelRecordFromRow(created)
}

export const updateProviderModel = async ({
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

  return getProviderModelRecordFromRow(updated)
}

export const upsertDiscoveredModels = async ({
  connection,
  models,
}: {
  connection: ProviderConnectionRecord
  models: ProviderListedModel[]
}): Promise<ProviderModelRecord[]> => {
  return (await getAppDatabaseService().transaction(async () => {
    return upsertDiscoveredProviderModelsRecursively({connection, discoveredModels: models, processed: []})
  })) as ProviderModelRecord[]
}

export const getProviderModels = async (modelIds: string[]): Promise<Map<string, ProviderModelRecord>> => {
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
      return [row.id, getProviderModelRecordFromRow(row)]
    }),
  )
}

export const assertSelectableProviderModelIds = async (
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

export const assertSelectableProviderModelId = async (
  databaseRunner: DatabaseQueryRunner,
  {errorMessage, modelId}: {errorMessage: string; modelId: string},
): Promise<string> => {
  const [validatedModelId] = await assertSelectableProviderModelIds(databaseRunner, {errorMessage, modelIds: [modelId]})

  if (!validatedModelId) {
    throw new Error(errorMessage)
  }

  return validatedModelId
}

export const getProviderModelRepository = () => {
  return {
    assertSelectableId: assertSelectableProviderModelId,
    assertSelectableIds: assertSelectableProviderModelIds,
    create: createProviderModel,
    getByIds: getProviderModels,
    listSelectable: listSelectableProviderModels,
    update: updateProviderModel,
    upsertDiscovered: upsertDiscoveredModels,
  }
}

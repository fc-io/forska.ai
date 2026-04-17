import {type ModelSource} from '../../db/schemaTypes.ts'
import {getProviderModelOptions, type ProviderModelOptions} from '../../utils/providerModelOptions.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  type DatabaseQueryRunner,
  type DatabaseRunner,
  getJsonSqlLiteral,
  getProviderConnectionConfigFromJson,
  getProviderModelRecordFromRow,
  getProviderModelReturnQuery,
  type ProviderModelRow,
} from './providerDbUtils.ts'
import {
  getPersistedProviderModelMetadata,
  getProviderModelMetadataOptions,
  setProviderModelMetadataOptions,
} from './providerModelMetadata.ts'
import {type ProviderConnectionRecord, type ProviderListedModel, type ProviderModelRecord} from './providerTypes.ts'

const getProviderModelRows = async ({enabledOnly}: {enabledOnly: boolean}): Promise<ProviderModelRecord[]> => {
  const enabledClause = enabledOnly ? `WHERE COALESCE(pc.enabled, TRUE) = TRUE` : ''
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
    ${enabledClause}
    ORDER BY COALESCE(pc.label, m.name) ASC, m.created_at ASC, m.name ASC
  `)

  return rows.map(getProviderModelRecordFromRow).filter((model) => {
    return enabledOnly ? model.enabled : true
  })
}

const getExistingProviderModelId = async ({
  databaseRunner,
  providerConnectionId,
  remoteModelId,
  variant,
}: {
  databaseRunner: DatabaseQueryRunner
  providerConnectionId: string
  remoteModelId: string
  variant: string | null
}): Promise<string | null> => {
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

const getProviderModelRowByIdWithRunner = async (
  databaseRunner: DatabaseQueryRunner,
  id: string,
): Promise<ProviderModelRow | null> => {
  const [row] = await databaseRunner.queryJson<ProviderModelRow>(`
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
    WHERE m.id = ${getSqlLiteral(id)}
    LIMIT 1
  `)

  return row ?? null
}

const getProviderModelRowById = async (id: string): Promise<ProviderModelRow | null> => {
  return getProviderModelRowByIdWithRunner(getAppDatabaseService(), id)
}

const updateProviderConnectionDisabledModelIds = async ({
  connectionConfigJson,
  databaseRunner,
  enabled,
  id,
  providerConnectionId,
  providerKind,
}: {
  connectionConfigJson: unknown
  databaseRunner: DatabaseRunner
  enabled: boolean
  id: string
  providerConnectionId: string
  providerKind: string | null
}): Promise<void> => {
  const currentConfig = getProviderConnectionConfigFromJson({providerKind, value: connectionConfigJson})
  const currentDisabledModelIds = currentConfig.disabledModelIds ?? []
  const nextDisabledModelIds = enabled
    ? currentDisabledModelIds.filter((modelId) => {
        return modelId !== id
      })
    : Array.from(new Set([...currentDisabledModelIds, id]))

  await databaseRunner.run(`
    UPDATE app.provider_connection
    SET config_json = ${getJsonSqlLiteral({...currentConfig, disabledModelIds: nextDisabledModelIds})},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(providerConnectionId)}
  `)
}

const updateProviderModelRow = async ({
  databaseRunner,
  displayName,
  enabled,
  id,
  metadataJson,
  variant,
}: {
  databaseRunner: DatabaseRunner
  displayName: string
  enabled: boolean
  id: string
  metadataJson: unknown
  variant: string | null
}): Promise<void> => {
  await databaseRunner.run(`
    UPDATE app.model
    SET name = ${getSqlLiteral(displayName)},
        display_name = ${getSqlLiteral(displayName)},
        enabled = ${getSqlLiteral(enabled)},
        metadata_json = ${getJsonSqlLiteral(metadataJson)},
        variant = ${getSqlLiteral(variant)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(id)}
  `)
}

const hasReferencedProviderModel = async ({
  databaseRunner,
  id,
}: {
  databaseRunner: DatabaseQueryRunner
  id: string
}): Promise<boolean> => {
  const [usage] = await databaseRunner.queryJson<{judgmentCount: number; projectCount: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.project WHERE model_id = ${getSqlLiteral(id)}) AS projectCount,
      (SELECT COUNT(*) FROM app.judgment WHERE model_id = ${getSqlLiteral(id)}) AS judgmentCount
  `)

  return (usage?.projectCount ?? 0) > 0 || (usage?.judgmentCount ?? 0) > 0
}

const upsertDiscoveredProviderModelsRecursively = async ({
  connection,
  databaseRunner,
  discoveredModels,
  processed,
}: {
  connection: ProviderConnectionRecord
  databaseRunner: DatabaseRunner
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
  const variant = currentModel.variant
  const existingId = await getExistingProviderModelId({
    databaseRunner,
    providerConnectionId: connection.id,
    remoteModelId,
    variant,
  })
  const existingRow = existingId ? await getProviderModelRowByIdWithRunner(databaseRunner, existingId) : null
  const existingModel = existingRow ? getProviderModelRecordFromRow(existingRow) : null
  const shouldPreserveReferencedModel = existingId
    ? await hasReferencedProviderModel({databaseRunner, id: existingId})
    : false
  const metadataJson = setProviderModelMetadataOptions(
    getPersistedProviderModelMetadata({
      listedModel: currentModel,
      metadataJson: currentModel.metadataJson,
      providerKind: connection.providerKind,
      source: 'provider',
    }),
    existingModel
      ? getProviderModelMetadataOptions(existingModel.metadataJson)
      : getProviderModelOptions(currentModel.metadataJson),
  )
  const persistedMetadataJson =
    metadataJson
    ?? getPersistedProviderModelMetadata({
      listedModel: currentModel,
      metadataJson: currentModel.metadataJson,
      providerKind: connection.providerKind,
      source: 'provider',
    })
  const [saved] =
    shouldPreserveReferencedModel && existingRow
      ? [existingRow]
      : await databaseRunner.queryJson<ProviderModelRow>(
          existingId
            ? getProviderModelReturnQuery(`
            UPDATE app.model
            SET name = ${getSqlLiteral(displayName)},
                remote_model_id = ${getSqlLiteral(remoteModelId)},
                display_name = ${getSqlLiteral(displayName)},
                variant = ${getSqlLiteral(variant)},
                source = 'discovered',
                metadata_json = ${getJsonSqlLiteral(persistedMetadataJson)},
                updated_at = current_timestamp
            WHERE id = ${getSqlLiteral(existingId)}
          `)
            : getProviderModelReturnQuery(`
            INSERT INTO app.model (
              id,
              provider_connection_id,
              name,
              remote_model_id,
              display_name,
              variant,
              source,
              enabled,
              metadata_json
            )
            VALUES (
              ${getSqlLiteral(crypto.randomUUID())},
              ${getSqlLiteral(connection.id)},
              ${getSqlLiteral(displayName)},
              ${getSqlLiteral(remoteModelId)},
              ${getSqlLiteral(displayName)},
              ${getSqlLiteral(variant)},
              'discovered',
              TRUE,
              ${getJsonSqlLiteral(persistedMetadataJson)}
            )
          `),
        )

  return upsertDiscoveredProviderModelsRecursively({
    connection,
    databaseRunner,
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
  const persistedMetadataJson = getPersistedProviderModelMetadata({
    listedModel: {displayName, metadataJson, modelName, remoteModelId, variant, version},
    metadataJson,
    providerKind: connection.providerKind,
    source: source === 'manual' ? 'manual' : 'provider',
  })
  const [created] = await getAppDatabaseService().queryJson<ProviderModelRow>(
    getProviderModelReturnQuery(`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      )
      VALUES (
        ${getSqlLiteral(crypto.randomUUID())},
        ${getSqlLiteral(connection.id)},
        ${getSqlLiteral(displayName)},
        ${getSqlLiteral(remoteModelId)},
        ${getSqlLiteral(displayName)},
        ${getSqlLiteral(variant)},
        ${getSqlLiteral(source)},
        TRUE,
        ${getJsonSqlLiteral(persistedMetadataJson)}
      )
    `),
  )

  if (!created) {
    throw new Error('Failed to create provider model')
  }

  return getProviderModelRecordFromRow(created)
}

export const updateProviderModel = async (
  {
    displayName,
    enabled,
    id,
    options,
    variant,
  }: {displayName: string; enabled: boolean; id: string; options?: ProviderModelOptions; variant: string | null},
  {afterModelWrite}: {afterModelWrite?: () => Promise<void>} = {},
): Promise<ProviderModelRecord> => {
  const currentRow = await getProviderModelRowById(id)

  if (!currentRow) {
    throw new Error('Provider model not found')
  }

  const currentModel = getProviderModelRecordFromRow(currentRow)
  const currentOptions = getProviderModelMetadataOptions(currentModel.metadataJson)
  const nextOptions = options ?? currentOptions
  const nextMetadataJson = setProviderModelMetadataOptions(currentModel.metadataJson, nextOptions)
  const displayNameChanged = displayName !== (currentModel.displayName ?? currentModel.name)
  const variantChanged = variant !== currentModel.variant
  const enabledChanged = enabled !== currentModel.enabled
  const optionsChanged = nextOptions.thinking !== currentOptions.thinking

  if (!enabledChanged && !displayNameChanged && !optionsChanged && !variantChanged) {
    return currentModel
  }

  const refreshedRow = (await getAppDatabaseService().transaction(async (databaseRunner) => {
    await updateProviderModelRow({databaseRunner, displayName, enabled, id, metadataJson: nextMetadataJson, variant})

    if (enabledChanged && currentRow.providerConnectionId) {
      await afterModelWrite?.()
      await updateProviderConnectionDisabledModelIds({
        connectionConfigJson: currentRow.connectionConfigJson,
        databaseRunner,
        enabled,
        id,
        providerConnectionId: currentRow.providerConnectionId,
        providerKind: currentRow.provider,
      })
    }

    return getProviderModelRowByIdWithRunner(databaseRunner, id)
  })) as ProviderModelRow | null

  if (!refreshedRow) {
    throw new Error('Provider model not found')
  }

  return getProviderModelRecordFromRow(refreshedRow)
}

export const upsertDiscoveredModels = async ({
  connection,
  models,
}: {
  connection: ProviderConnectionRecord
  models: ProviderListedModel[]
}): Promise<ProviderModelRecord[]> => {
  return (await getAppDatabaseService().transaction(async (databaseRunner) => {
    return upsertDiscoveredProviderModelsRecursively({
      connection,
      databaseRunner,
      discoveredModels: models,
      processed: [],
    })
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

  const rows = await databaseRunner.queryJson<{
    connectionConfigJson: unknown
    enabled: boolean | null
    id: string
    provider: string | null
    providerConnectionEnabled: boolean | null
  }>(`
    SELECT
      m.id AS id,
      TO_JSON(pc.config_json) AS connectionConfigJson,
      COALESCE(m.enabled, TRUE) AS enabled,
      pc.provider_kind AS provider,
      COALESCE(pc.enabled, TRUE) AS providerConnectionEnabled
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id IN (${getQuotedStringList(modelIds).join(', ')})
      AND COALESCE(pc.enabled, TRUE) = TRUE
  `)

  const selectableRows = rows.filter((row) => {
    return (
      row.provider !== 'docling'
      && getProviderModelRecordFromRow({
        baseURL: null,
        connectionConfigJson: row.connectionConfigJson,
        createdAt: null,
        displayName: null,
        enabled: row.enabled,
        id: row.id,
        metadataJson: null,
        modelName: null,
        name: row.id,
        provider: row.provider,
        providerConnectionEnabled: row.providerConnectionEnabled,
        providerConnectionId: null,
        remoteModelId: null,
        source: null,
        updatedAt: null,
        variant: null,
        version: null,
      }).enabled
    )
  })

  if (selectableRows.length !== modelIds.length) {
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

import {
  getPersistedProviderConnectionConfigValue,
  getProviderConnectionConfigFromJson,
} from '../src/server/providers/providerDbUtils.ts'
import {getPersistedProviderModelMetadata} from '../src/server/providers/providerModelMetadata.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {normalizeProviderKind} from '../src/server/services/providerCatalog.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const getConnectionUpdates = async () => {
  const rows = await getAppDatabaseService().queryJson<{configJson: unknown; id: string; providerKind: string | null}>(`
    SELECT
      id,
      provider_kind AS providerKind,
      TO_JSON(config_json) AS configJson
    FROM app.provider_connection
  `)

  return rows.flatMap((row) => {
    const persistedConfig = getPersistedProviderConnectionConfigValue({
      config: getProviderConnectionConfigFromJson({providerKind: row.providerKind, value: row.configJson}),
      providerKind: row.providerKind,
    })
    const currentConfig = getJsonValue(row.configJson)

    return JSON.stringify(currentConfig) === JSON.stringify(persistedConfig) ? [] : [{id: row.id, persistedConfig}]
  })
}

const getModelUpdates = async () => {
  const rows = await getAppDatabaseService().queryJson<{
    displayName: string | null
    id: string
    metadataJson: unknown
    modelName: string | null
    providerKind: string | null
    remoteModelId: string | null
    source: string | null
    variant: string | null
    version: string | null
  }>(`
    SELECT
      m.id,
      COALESCE(m.display_name, m.name) AS displayName,
      COALESCE(m.model_name, m.remote_model_id) AS modelName,
      m.remote_model_id AS remoteModelId,
      pc.provider_kind AS providerKind,
      m.source AS source,
      m.variant AS variant,
      m.version AS version,
      TO_JSON(m.metadata_json) AS metadataJson
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
  `)

  return rows.flatMap((row) => {
    const displayName = String(row.displayName ?? row.remoteModelId ?? row.modelName ?? row.id)
    const modelName = String(row.modelName ?? row.remoteModelId ?? displayName)
    const remoteModelId = String(row.remoteModelId ?? row.modelName ?? displayName)
    const persistedMetadata = getPersistedProviderModelMetadata({
      listedModel: {
        displayName,
        metadataJson: getJsonValue(row.metadataJson),
        modelName,
        remoteModelId,
        variant: row.variant,
        version: row.version,
      },
      metadataJson: getJsonValue(row.metadataJson),
      providerKind: normalizeProviderKind(row.providerKind),
      source: row.source === 'manual' ? 'manual' : 'provider',
    })
    const currentMetadata = getJsonValue(row.metadataJson)

    return JSON.stringify(currentMetadata) === JSON.stringify(persistedMetadata)
      ? []
      : [{id: row.id, persistedMetadata}]
  })
}

const run = async () => {
  const [connectionUpdates, modelUpdates] = await Promise.all([getConnectionUpdates(), getModelUpdates()])

  for (const update of connectionUpdates) {
    await getAppDatabaseService().run(`
      UPDATE app.provider_connection
      SET config_json = ${update.persistedConfig === null ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(update.persistedConfig))} AS JSON)`},
          updated_at = current_timestamp
      WHERE id = ${getSqlLiteral(update.id)}
    `)
  }

  for (const update of modelUpdates) {
    await getAppDatabaseService().run(`
      UPDATE app.model
      SET metadata_json = ${update.persistedMetadata === null ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(update.persistedMetadata))} AS JSON)`},
          updated_at = current_timestamp
      WHERE id = ${getSqlLiteral(update.id)}
    `)
  }

  console.log(
    JSON.stringify({providerConnectionUpdates: connectionUpdates.length, providerModelUpdates: modelUpdates.length}),
  )
}

await withDuckdbMaintenanceAccess('slim provider metadata', run)

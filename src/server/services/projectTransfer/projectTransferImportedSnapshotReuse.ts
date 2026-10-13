import {getProviderModelVersionSelectSql} from '../../providers/providerDbUtils.ts'
import {getJsonValue, getSqlLiteral} from '../appQueryHelpers.ts'
import {normalizeProjectTransferModelVariant} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferModelSnapshotFingerprint,
  getProjectTransferProviderSnapshotFingerprint,
  projectTransferSnapshotFingerprintsEqual,
} from './projectTransferSnapshotFingerprint.ts'

export type ProjectTransferImportedSnapshotSourceProvider = {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  providerKind: string
  sourceProviderConnectionId: string
}

export type ProjectTransferImportedSnapshotSourceModel = {
  displayName: string | null
  metadataJson: unknown
  modelName: string | null
  name: string
  remoteModelId: string | null
  sourceModelId: string
  variant: string | null
  version: string | null
}

export type ProjectTransferImportedSnapshotProviderRow = {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  id: string
  providerKind: string
}

export type ProjectTransferImportedSnapshotModelRow = {
  displayName: string | null
  id: string
  metadataJson: unknown
  name: string
  providerAuthMode: string | null
  providerBaseURL: string | null
  providerConfigJson: unknown
  providerKind: string
  remoteModelId: string | null
  variant: string | null
  version: string | null
}

export type ProjectTransferImportedSnapshotLookup = {matchingCount: number; reusableId: string | null; rowCount: number}

type ProjectTransferImportedSnapshotQueryRunner = {queryJson: <TRow>(statement: string) => Promise<TRow[]>}

const importedSnapshotMarkerKey = 'projectTransferImportedSnapshot'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getNonBlankString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export const getProjectTransferImportedSnapshotMarker = (value: unknown) => {
  const parsed = getJsonValue(value)
  const marker = isRecord(parsed) ? parsed[importedSnapshotMarkerKey] : null

  return isRecord(marker) ? marker : null
}

export const getProjectTransferImportedSnapshotJson = (value: unknown, snapshot: Record<string, unknown>) => {
  const parsed = getJsonValue(value)
  const record = isRecord(parsed) ? parsed : {}

  return {...record, [importedSnapshotMarkerKey]: snapshot}
}

export const getProjectTransferImportedSnapshotSourceProvider = (
  record: Record<string, unknown>,
): ProjectTransferImportedSnapshotSourceProvider => {
  return {
    authMode: getNonBlankString(record.authMode),
    baseURL: getNonBlankString(record.baseURL),
    configJson: record.configJson ?? null,
    providerKind: getNonBlankString(record.providerKind) ?? '',
    sourceProviderConnectionId: getNonBlankString(record.sourceProviderConnectionId) ?? '',
  }
}

export const getProjectTransferImportedSnapshotSourceModel = (
  record: Record<string, unknown>,
): ProjectTransferImportedSnapshotSourceModel => {
  return {
    displayName: getNonBlankString(record.displayName),
    metadataJson: record.metadataJson ?? null,
    modelName: getNonBlankString(record.modelName),
    name: getNonBlankString(record.name) ?? '',
    remoteModelId: getNonBlankString(record.remoteModelId),
    sourceModelId: getNonBlankString(record.sourceModelId) ?? '',
    variant: normalizeProjectTransferModelVariant(record.variant),
    version: normalizeProjectTransferModelVariant(record.version),
  }
}

export const getProjectTransferImportedSnapshotRemoteModelId = (model: ProjectTransferImportedSnapshotSourceModel) => {
  return model.remoteModelId ?? model.modelName
}

export const getProjectTransferImportedProviderSnapshotFingerprint = (
  provider: ProjectTransferImportedSnapshotSourceProvider,
) => {
  return getProjectTransferProviderSnapshotFingerprint({
    authMode: provider.authMode,
    baseURL: provider.baseURL,
    configJson: provider.configJson,
    providerKind: provider.providerKind,
  })
}

export const getProjectTransferImportedModelSnapshotFingerprint = ({
  model,
  provider,
}: {
  model: ProjectTransferImportedSnapshotSourceModel
  provider: ProjectTransferImportedSnapshotSourceProvider
}) => {
  return getProjectTransferModelSnapshotFingerprint({
    displayName: model.displayName,
    metadataJson: model.metadataJson,
    modelName: model.modelName,
    name: model.name,
    provider: {
      authMode: provider.authMode,
      baseURL: provider.baseURL,
      configJson: provider.configJson,
      providerKind: provider.providerKind,
    },
    remoteModelId: model.remoteModelId,
    variant: model.variant,
    version: model.version,
  })
}

const getTargetProviderSnapshotFingerprint = (row: ProjectTransferImportedSnapshotProviderRow) => {
  return getProjectTransferProviderSnapshotFingerprint({
    authMode: row.authMode,
    baseURL: row.baseURL,
    configJson: row.configJson,
    providerKind: row.providerKind,
  })
}

const getTargetModelSnapshotFingerprint = ({
  row,
  sourceModel,
}: {
  row: ProjectTransferImportedSnapshotModelRow
  sourceModel: ProjectTransferImportedSnapshotSourceModel
}) => {
  return getProjectTransferModelSnapshotFingerprint({
    displayName: row.displayName,
    metadataJson: row.metadataJson,
    modelName: sourceModel.modelName,
    name: row.name,
    provider: {
      authMode: row.providerAuthMode,
      baseURL: row.providerBaseURL,
      configJson: row.providerConfigJson,
      providerKind: row.providerKind,
    },
    remoteModelId: sourceModel.remoteModelId,
    variant: row.variant,
    version: row.version,
  })
}

const markerFingerprintMatches = ({fingerprint, marker}: {fingerprint: unknown; marker: Record<string, unknown>}) => {
  return projectTransferSnapshotFingerprintsEqual(marker.snapshotFingerprint, fingerprint)
}

const modelSnapshotIdentityMatches = ({
  row,
  sourceModel,
}: {
  row: ProjectTransferImportedSnapshotModelRow
  sourceModel: ProjectTransferImportedSnapshotSourceModel
}) => {
  return (
    row.name === sourceModel.name
    && row.remoteModelId === getProjectTransferImportedSnapshotRemoteModelId(sourceModel)
    && row.displayName === sourceModel.displayName
    && normalizeProjectTransferModelVariant(row.variant) === normalizeProjectTransferModelVariant(sourceModel.variant)
    && normalizeProjectTransferModelVariant(row.version) === normalizeProjectTransferModelVariant(sourceModel.version)
  )
}

export const projectTransferImportedProviderSnapshotMatches = ({
  row,
  sourceProvider,
}: {
  row: ProjectTransferImportedSnapshotProviderRow
  sourceProvider: ProjectTransferImportedSnapshotSourceProvider
}) => {
  const marker = getProjectTransferImportedSnapshotMarker(row.configJson)
  const sourceFingerprint = getProjectTransferImportedProviderSnapshotFingerprint(sourceProvider)

  return (
    marker !== null
    && marker.sourceProviderConnectionId === sourceProvider.sourceProviderConnectionId
    && markerFingerprintMatches({fingerprint: sourceFingerprint, marker})
    && projectTransferSnapshotFingerprintsEqual(getTargetProviderSnapshotFingerprint(row), sourceFingerprint)
  )
}

export const projectTransferImportedModelSnapshotMatches = ({
  row,
  sourceModel,
  sourceProvider,
}: {
  row: ProjectTransferImportedSnapshotModelRow
  sourceModel: ProjectTransferImportedSnapshotSourceModel
  sourceProvider: ProjectTransferImportedSnapshotSourceProvider
}) => {
  const marker = getProjectTransferImportedSnapshotMarker(row.metadataJson)
  const sourceFingerprint = getProjectTransferImportedModelSnapshotFingerprint({
    model: sourceModel,
    provider: sourceProvider,
  })

  return (
    marker !== null
    && marker.sourceModelId === sourceModel.sourceModelId
    && modelSnapshotIdentityMatches({row, sourceModel})
    && markerFingerprintMatches({fingerprint: sourceFingerprint, marker})
    && projectTransferSnapshotFingerprintsEqual(
      getTargetModelSnapshotFingerprint({row, sourceModel}),
      sourceFingerprint,
    )
  )
}

const getImportedProviderSnapshotRowsSql = (sourceProviderConnectionId: string) => {
  return `
    SELECT
      id,
      provider_kind AS providerKind,
      auth_mode AS authMode,
      base_url AS baseURL,
      TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE json_extract_string(config_json, '$.${importedSnapshotMarkerKey}.sourceProviderConnectionId')
      = ${getSqlLiteral(sourceProviderConnectionId)}
    ORDER BY created_at ASC, id ASC
  `
}

const getImportedModelSnapshotRowsSql = ({
  providerConnectionId,
  sourceModelId,
}: {
  providerConnectionId: string
  sourceModelId: string
}) => {
  return `
    SELECT
      model.id,
      model.name,
      model.remote_model_id AS remoteModelId,
      model.display_name AS displayName,
      model.variant,
      ${getProviderModelVersionSelectSql('model')} AS version,
      TO_JSON(model.metadata_json) AS metadataJson,
      provider.provider_kind AS providerKind,
      provider.auth_mode AS providerAuthMode,
      provider.base_url AS providerBaseURL,
      TO_JSON(provider.config_json) AS providerConfigJson
    FROM app.model model
    INNER JOIN app.provider_connection provider ON provider.id = model.provider_connection_id
    WHERE model.provider_connection_id = ${getSqlLiteral(providerConnectionId)}
      AND json_extract_string(model.metadata_json, '$.${importedSnapshotMarkerKey}.sourceModelId')
        = ${getSqlLiteral(sourceModelId)}
    ORDER BY model.created_at ASC, model.id ASC
  `
}

const getSnapshotLookup = <TRow extends {id: string}>(
  rows: readonly TRow[],
  matches: (row: TRow) => boolean,
): ProjectTransferImportedSnapshotLookup => {
  const matchingRows = rows.filter(matches)

  return {
    matchingCount: matchingRows.length,
    reusableId: matchingRows.length === 1 ? (matchingRows[0]?.id ?? null) : null,
    rowCount: rows.length,
  }
}

export const getProjectTransferReusableImportedProviderSnapshot = async ({
  runner,
  sourceProvider,
}: {
  runner: ProjectTransferImportedSnapshotQueryRunner
  sourceProvider: ProjectTransferImportedSnapshotSourceProvider
}) => {
  const rows = await runner.queryJson<ProjectTransferImportedSnapshotProviderRow>(
    getImportedProviderSnapshotRowsSql(sourceProvider.sourceProviderConnectionId),
  )

  return getSnapshotLookup(rows, (row) => {
    return projectTransferImportedProviderSnapshotMatches({row, sourceProvider})
  })
}

export const getProjectTransferReusableImportedModelSnapshot = async ({
  providerConnectionId,
  runner,
  sourceModel,
  sourceProvider,
}: {
  providerConnectionId: string
  runner: ProjectTransferImportedSnapshotQueryRunner
  sourceModel: ProjectTransferImportedSnapshotSourceModel
  sourceProvider: ProjectTransferImportedSnapshotSourceProvider
}) => {
  const rows = await runner.queryJson<ProjectTransferImportedSnapshotModelRow>(
    getImportedModelSnapshotRowsSql({providerConnectionId, sourceModelId: sourceModel.sourceModelId}),
  )

  return getSnapshotLookup(rows, (row) => {
    return projectTransferImportedModelSnapshotMatches({row, sourceModel, sourceProvider})
  })
}

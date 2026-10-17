import {getProviderConnectionConfigFromJson} from '../../providers/providerDbUtils.ts'
import {providerTransportSupportsImageInput} from '../../providers/providerImageInput.ts'
import {resolveProviderModelCapabilities} from '../../providers/providerModelCapabilities.ts'
import {getProviderRegistryEntry} from '../../providers/providerRegistry.ts'
import {HttpError} from '../../utils/httpError.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../appQueryHelpers.ts'

type FigureDescriptionModelRow = {
  displayName: string | null
  metadataJson: unknown
  modelId: string
  name: string
  providerConfigJson: unknown
  providerConnectionId: string
  providerKind: string | null
  providerLabel: string | null
  remoteModelId: string | null
  variant: string | null
}

export type FigureDescriptionModelOption = {
  capabilitySource: string
  id: string
  label: string
  providerConnectionId: string
  providerKind: string
}

export type FigureDescriptionModelConfig = {
  modelId: string
  modelLabel: string
  providerConnectionId: string
  providerKind: string
}

type FigureDescriptionModelQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

const getFigureDescriptionModelRows = async ({
  modelId,
  runner = getAppDatabaseService(),
  userConfigWhereClause,
}: {
  modelId?: string
  runner?: FigureDescriptionModelQueryRunner
  userConfigWhereClause?: string
}) => {
  const userConfigJoin = userConfigWhereClause
    ? `INNER JOIN app.user_config uc ON uc.figure_description_model_id = m.id AND ${userConfigWhereClause}`
    : ''

  return runner.queryJson<FigureDescriptionModelRow>(`
    SELECT
      m.id AS modelId,
      m.name AS name,
      m.display_name AS displayName,
      m.remote_model_id AS remoteModelId,
      m.variant AS variant,
      TO_JSON(m.metadata_json) AS metadataJson,
      pc.id AS providerConnectionId,
      pc.label AS providerLabel,
      pc.provider_kind AS providerKind,
      TO_JSON(pc.config_json) AS providerConfigJson
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    ${userConfigJoin}
    WHERE COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
      ${modelId === undefined ? '' : `AND m.id = ${getSqlLiteral(modelId)}`}
    ORDER BY pc.label ASC, COALESCE(m.display_name, m.remote_model_id, m.name) ASC, m.id ASC
  `)
}

const getFigureDescriptionModelImageCapability = (row: FigureDescriptionModelRow) => {
  return resolveProviderModelCapabilities({
    metadataJson: getJsonValue(row.metadataJson),
    providerKind: row.providerKind,
    remoteModelId: row.remoteModelId,
  }).supportsImageInput
}

const isFigureDescriptionModelRowSelectable = (row: FigureDescriptionModelRow): boolean => {
  const config = getProviderConnectionConfigFromJson({providerKind: row.providerKind, value: row.providerConfigJson})
  const transportFamily = getProviderRegistryEntry(row.providerKind)?.transportFamily ?? null

  return (
    !config.archived
    && !config.disabledModelIds?.includes(row.modelId)
    && transportFamily !== null
    && providerTransportSupportsImageInput(transportFamily)
    && getFigureDescriptionModelImageCapability(row)?.value === true
  )
}

const getFigureDescriptionModelLabel = (row: FigureDescriptionModelRow): string => {
  const modelLabel = row.displayName ?? row.remoteModelId ?? row.name
  const modelLabelWithVariant = row.variant ? `${modelLabel} ${row.variant}` : modelLabel

  return row.providerLabel ? `${modelLabelWithVariant} (${row.providerLabel})` : modelLabelWithVariant
}

const getFigureDescriptionModelOption = (row: FigureDescriptionModelRow): FigureDescriptionModelOption => {
  return {
    capabilitySource: getFigureDescriptionModelImageCapability(row)?.source ?? 'absent',
    id: row.modelId,
    label: getFigureDescriptionModelLabel(row),
    providerConnectionId: row.providerConnectionId,
    providerKind: row.providerKind ?? '',
  }
}

export const listFigureDescriptionModelOptions = async (): Promise<FigureDescriptionModelOption[]> => {
  const rows = await getFigureDescriptionModelRows({})

  return rows.filter(isFigureDescriptionModelRowSelectable).map(getFigureDescriptionModelOption)
}

export const getValidatedFigureDescriptionModelId = async (value: string | null): Promise<string | null> => {
  const normalizedModelId = String(value ?? '').trim()
  const rows = normalizedModelId === '' ? [] : await getFigureDescriptionModelRows({modelId: normalizedModelId})

  if (normalizedModelId !== '' && !rows.some(isFigureDescriptionModelRowSelectable)) {
    throw new HttpError(400, 'Selected figure-description model is not available or cannot receive images')
  }

  return normalizedModelId === '' ? null : normalizedModelId
}

export const getFigureDescriptionModelConfig = async ({
  runner,
  userConfigWhereClause,
}: {
  runner?: FigureDescriptionModelQueryRunner
  userConfigWhereClause: string
}): Promise<FigureDescriptionModelConfig | null> => {
  const [row] = (await getFigureDescriptionModelRows({runner, userConfigWhereClause})).filter(
    isFigureDescriptionModelRowSelectable,
  )

  return row
    ? {
        modelId: row.modelId,
        modelLabel: getFigureDescriptionModelLabel(row),
        providerConnectionId: row.providerConnectionId,
        providerKind: row.providerKind ?? '',
      }
    : null
}

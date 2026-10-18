import {getProviderConnectionConfigFromJson} from '../providers/providerDbUtils.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'
import {fullTextConversionProviderKinds} from './providerCatalog.ts'
import {getLocalUserConfigWhereClauseSql} from './userConfigQueryService.ts'

type FullTextModelStatusRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type FullTextModelRole = 'pdf_conversion'

export type FullTextModelHealthState = 'disabled' | 'failed' | 'healthy' | 'unverified'

export type FullTextModelCapabilityState = 'missing' | 'unverified' | 'verified'

export type FullTextModelStatus = {
  capability: {detail: string; label: string; state: FullTextModelCapabilityState}
  health: {detail: string; lastCheckedAt: string | null; lastError: string | null; state: FullTextModelHealthState}
  modelId: string
  modelLabel: string
  providerConnectionId: string
  providerKind: string | null
  providerLabel: string
  role: FullTextModelRole
}

export type FullTextModelStatusRow = {
  connectionEnabled: boolean | null
  lastCheckedAt: unknown
  lastError: string | null
  metadataJson: unknown
  modelEnabled: boolean | null
  modelId: string
  modelLabel: string
  providerConfigJson: unknown
  providerConnectionId: string
  providerKind: string | null
  providerLabel: string | null
  remoteModelId: string | null
}

type ConfiguredFullTextModelIdsRow = {fullTextConversionModelId: string | null}

const capabilityLabels: Record<FullTextModelRole, string> = {pdf_conversion: 'Converter server version'}

const getCheckedAtLabel = (date: Date): string => {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const isModelRowDisabled = (row: FullTextModelStatusRow): boolean => {
  const config = getProviderConnectionConfigFromJson({providerKind: row.providerKind, value: row.providerConfigJson})

  return (
    row.modelEnabled === false
    || row.connectionEnabled === false
    || Boolean(config.archived)
    || Boolean(config.disabledModelIds?.includes(row.modelId))
  )
}

const getTrimmedError = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? ''

  return trimmed === '' ? null : trimmed
}

const getHealthState = (row: FullTextModelStatusRow): FullTextModelHealthState => {
  return isModelRowDisabled(row)
    ? 'disabled'
    : getTrimmedError(row.lastError)
      ? 'failed'
      : getDateValue(row.lastCheckedAt)
        ? 'healthy'
        : 'unverified'
}

export const getHealthDetail = ({
  lastCheckedAt,
  lastError,
  providerLabel,
  state,
}: {
  lastCheckedAt: Date | null
  lastError: string | null
  providerLabel: string
  state: FullTextModelHealthState
}): string => {
  const checkedAt = lastCheckedAt ? getCheckedAtLabel(lastCheckedAt) : 'an unknown time'
  const details: Record<FullTextModelHealthState, string> = {
    disabled: `The model or its provider ${providerLabel} is disabled. Enable both on the Models page.`,
    failed: `The last health check of ${providerLabel} failed at ${checkedAt}: ${lastError ?? 'unknown error'}.`,
    healthy: `The last health check of ${providerLabel} passed at ${checkedAt}.`,
    unverified: `${providerLabel} has not been health-checked yet. Test the connection on the Models page.`,
  }

  return details[state]
}

const getConverterServerVersion = (metadataJson: unknown): string | null => {
  const metadata = getJsonValue(metadataJson) as {converter?: {serverVersion?: unknown}} | null
  const serverVersion = metadata?.converter?.serverVersion

  return typeof serverVersion === 'string' && serverVersion.trim() !== '' ? serverVersion.trim() : null
}

const isFullTextConversionProviderKind = (providerKind: string | null): boolean => {
  return (fullTextConversionProviderKinds as readonly string[]).includes(providerKind ?? '')
}

const getPdfConversionCapability = (row: FullTextModelStatusRow): FullTextModelStatus['capability'] => {
  const serverVersion = getConverterServerVersion(row.metadataJson)

  return !isFullTextConversionProviderKind(row.providerKind)
    ? {detail: 'Not a MinerU or Docling model.', label: capabilityLabels.pdf_conversion, state: 'missing'}
    : serverVersion
      ? {
          detail: `Reports ${row.providerKind} ${serverVersion}.`,
          label: capabilityLabels.pdf_conversion,
          state: 'verified',
        }
      : {
          detail: `${row.modelLabel} has not reported a server version. Refresh its provider's models on the Models page.`,
          label: capabilityLabels.pdf_conversion,
          state: 'unverified',
        }
}

export const getFullTextModelStatusFromRow = (
  row: FullTextModelStatusRow,
  role: FullTextModelRole,
): FullTextModelStatus => {
  const providerLabel = row.providerLabel ?? row.providerKind ?? 'its provider'
  const lastCheckedAt = getDateValue(row.lastCheckedAt)
  const lastError = getTrimmedError(row.lastError)
  const state = getHealthState(row)

  return {
    capability: getPdfConversionCapability(row),
    health: {
      detail: getHealthDetail({lastCheckedAt, lastError, providerLabel, state}),
      lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
      lastError,
      state,
    },
    modelId: row.modelId,
    modelLabel: row.modelLabel,
    providerConnectionId: row.providerConnectionId,
    providerKind: row.providerKind,
    providerLabel,
    role,
  }
}

export const getFullTextModelStatus = async ({
  modelId,
  role,
  runner = getAppDatabaseService(),
}: {
  modelId: string
  role: FullTextModelRole
  runner?: FullTextModelStatusRunner
}): Promise<FullTextModelStatus | null> => {
  const [row] = await runner.queryJson<FullTextModelStatusRow>(`
    SELECT
      m.id AS modelId,
      COALESCE(m.display_name, m.remote_model_id, m.name) AS modelLabel,
      m.remote_model_id AS remoteModelId,
      m.enabled AS modelEnabled,
      TO_JSON(m.metadata_json) AS metadataJson,
      pc.id AS providerConnectionId,
      pc.label AS providerLabel,
      pc.provider_kind AS providerKind,
      pc.enabled AS connectionEnabled,
      TO_JSON(pc.config_json) AS providerConfigJson,
      pc.last_checked_at AS lastCheckedAt,
      pc.last_error AS lastError
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  return row ? getFullTextModelStatusFromRow(row, role) : null
}

export const getConfiguredFullTextModelIds = async (
  runner: FullTextModelStatusRunner = getAppDatabaseService(),
): Promise<ConfiguredFullTextModelIdsRow> => {
  const [row] = await runner.queryJson<ConfiguredFullTextModelIdsRow>(`
    SELECT
      uc.full_text_conversion_model_id AS fullTextConversionModelId
    FROM app.user_config uc
    WHERE ${getLocalUserConfigWhereClauseSql('uc.id')}
    LIMIT 1
  `)

  return row ?? {fullTextConversionModelId: null}
}

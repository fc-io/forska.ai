import {
  getProviderModelCapabilityTableRow,
  type ProviderModelCapabilityTableBoolean,
  type ProviderModelCapabilityTableRow,
} from './providerModelCapabilityTable.ts'
import {
  getProviderModelMetadataConverter,
  getProviderModelMetadataDiscoveredContextWindow,
  getProviderModelMetadataDiscoveredInputSupport,
} from './providerModelMetadata.ts'

export type ProviderModelCapabilitySource = 'discovery' | 'shipped' | 'user'

type ProviderModelCapabilityProvenance = {
  source: ProviderModelCapabilitySource
  sourceUrl: string | null
  verifiedAt: string | null
}

export type ProviderModelContextWindowCapability = ProviderModelCapabilityProvenance & {
  inputTokens: number | null
  totalTokens: number | null
}

export type ProviderModelBooleanCapability = ProviderModelCapabilityProvenance & {value: boolean}

export type ProviderModelCapabilities = {
  contextWindow: ProviderModelContextWindowCapability | null
  supportsImageInput: ProviderModelBooleanCapability | null
  supportsPdfInput: ProviderModelBooleanCapability | null
}

export type ProviderModelCapabilityOverrides = {
  contextWindow: {inputTokens: number; totalTokens: number | null} | null
  supportsImageInput: boolean | null
  supportsPdfInput: boolean | null
}

export type ProviderModelCapabilityModel = {
  metadataJson: unknown
  providerKind: string | null
  remoteModelId: string | null
}

type StoredProviderModelCapabilityOverrides = ProviderModelCapabilityOverrides & {updatedAt: string | null}

export const modelContextWindowMissingLinkText = 'Models page'

export const getModelContextWindowMissingMessage = ({
  modelName,
  providerKind,
}: {
  modelName: string
  providerKind: string | null
}): string => {
  return `Model ${modelName} (${providerKind ?? 'unknown provider'}) has no verified context window. Add it on the ${modelContextWindowMissingLinkText}.`
}

export class ModelContextWindowMissingError extends Error {
  linkPath: string | null
  linkText: string
  modelName: string
  providerKind: string | null

  constructor({
    modelName,
    providerConnectionId,
    providerKind,
  }: {
    modelName: string
    providerConnectionId: string | null
    providerKind: string | null
  }) {
    super(getModelContextWindowMissingMessage({modelName, providerKind}))
    this.name = 'ModelContextWindowMissingError'
    this.linkPath = providerConnectionId ? `/providers/${providerConnectionId}` : null
    this.linkText = modelContextWindowMissingLinkText
    this.modelName = modelName
    this.providerKind = providerKind
  }
}

const getJsonRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getPositiveInteger = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

const getBooleanValue = (value: unknown): boolean | null => {
  return typeof value === 'boolean' ? value : null
}

const getStoredContextWindowOverride = (value: unknown): ProviderModelCapabilityOverrides['contextWindow'] => {
  const record = getJsonRecord(value)
  const inputTokens = getPositiveInteger(record?.inputTokens)

  return inputTokens === null ? null : {inputTokens, totalTokens: getPositiveInteger(record?.totalTokens)}
}

export const getProviderModelCapabilityOverrides = (metadataJson: unknown): StoredProviderModelCapabilityOverrides => {
  const overrides = getJsonRecord(getJsonRecord(metadataJson)?.capabilityOverrides)

  return {
    contextWindow: getStoredContextWindowOverride(overrides?.contextWindow),
    supportsImageInput: getBooleanValue(overrides?.supportsImageInput),
    supportsPdfInput: getBooleanValue(overrides?.supportsPdfInput),
    updatedAt: typeof overrides?.updatedAt === 'string' ? overrides.updatedAt : null,
  }
}

const hasProviderModelCapabilityOverride = (overrides: ProviderModelCapabilityOverrides): boolean => {
  return (
    overrides.contextWindow !== null || overrides.supportsImageInput !== null || overrides.supportsPdfInput !== null
  )
}

const getPersistedCapabilityOverrides = ({
  overrides,
  updatedAt,
}: {
  overrides: ProviderModelCapabilityOverrides
  updatedAt: string
}): Record<string, unknown> => {
  return {
    ...(overrides.contextWindow ? {contextWindow: overrides.contextWindow} : {}),
    ...(overrides.supportsImageInput === null ? {} : {supportsImageInput: overrides.supportsImageInput}),
    ...(overrides.supportsPdfInput === null ? {} : {supportsPdfInput: overrides.supportsPdfInput}),
    updatedAt,
  }
}

export const setProviderModelCapabilityOverrides = ({
  metadataJson,
  overrides,
  updatedAt,
}: {
  metadataJson: unknown
  overrides: ProviderModelCapabilityOverrides
  updatedAt: string
}): Record<string, unknown> | null => {
  const metadataRecord = getJsonRecord(metadataJson) ?? {}
  const {capabilityOverrides: _capabilityOverrides, ...rest} = metadataRecord
  const nextRecord = hasProviderModelCapabilityOverride(overrides)
    ? {...rest, capabilityOverrides: getPersistedCapabilityOverrides({overrides, updatedAt})}
    : rest

  return Object.keys(nextRecord).length > 0 ? nextRecord : null
}

export const carryProviderModelCapabilityOverrides = ({
  nextMetadataJson,
  previousMetadataJson,
}: {
  nextMetadataJson: unknown
  previousMetadataJson: unknown
}): unknown => {
  const previousOverrides = getJsonRecord(previousMetadataJson)?.capabilityOverrides
  const nextRecord = getJsonRecord(nextMetadataJson)

  return previousOverrides === undefined ? nextMetadataJson : {...nextRecord, capabilityOverrides: previousOverrides}
}

export const refreshProviderModelDiscovery = ({
  nextMetadataJson,
  previousMetadataJson,
}: {
  nextMetadataJson: unknown
  previousMetadataJson: unknown
}): unknown => {
  const discovery = getJsonRecord(nextMetadataJson)?.discovery
  const converter = getProviderModelMetadataConverter(nextMetadataJson)
  const refreshed = {...getJsonRecord(previousMetadataJson), discovery, ...(converter ? {converter} : {})}

  return discovery === undefined ? previousMetadataJson : refreshed
}

const getUserProvenance = (updatedAt: string | null): ProviderModelCapabilityProvenance => {
  return {source: 'user', sourceUrl: null, verifiedAt: updatedAt ? updatedAt.slice(0, 10) : null}
}

const discoveryProvenance: ProviderModelCapabilityProvenance = {source: 'discovery', sourceUrl: null, verifiedAt: null}

const getShippedProvenance = ({
  row,
  sourceUrl,
}: {
  row: ProviderModelCapabilityTableRow
  sourceUrl: string
}): ProviderModelCapabilityProvenance => {
  return {source: 'shipped', sourceUrl, verifiedAt: row.verifiedAt}
}

const getUserContextWindow = (
  overrides: StoredProviderModelCapabilityOverrides,
): ProviderModelContextWindowCapability | null => {
  return overrides.contextWindow ? {...overrides.contextWindow, ...getUserProvenance(overrides.updatedAt)} : null
}

const getDiscoveredContextWindow = (metadataJson: unknown): ProviderModelContextWindowCapability | null => {
  const discovered = getProviderModelMetadataDiscoveredContextWindow(metadataJson)

  return discovered.inputTokens === null && discovered.totalTokens === null
    ? null
    : {inputTokens: discovered.inputTokens, totalTokens: discovered.totalTokens, ...discoveryProvenance}
}

const getShippedContextWindow = (
  row: ProviderModelCapabilityTableRow | null,
): ProviderModelContextWindowCapability | null => {
  return row?.contextWindow
    ? {
        inputTokens: row.contextWindow.inputTokens,
        totalTokens: row.contextWindow.totalTokens,
        ...getShippedProvenance({row, sourceUrl: row.contextWindow.sourceUrl}),
      }
    : null
}

const getUserBoolean = ({
  updatedAt,
  value,
}: {
  updatedAt: string | null
  value: boolean | null
}): ProviderModelBooleanCapability | null => {
  return value === null ? null : {value, ...getUserProvenance(updatedAt)}
}

const getDiscoveredBoolean = (value: boolean | null): ProviderModelBooleanCapability | null => {
  return value === null ? null : {value, ...discoveryProvenance}
}

const getShippedBoolean = ({
  capability,
  row,
}: {
  capability: ProviderModelCapabilityTableBoolean | null | undefined
  row: ProviderModelCapabilityTableRow | null
}): ProviderModelBooleanCapability | null => {
  return row && capability
    ? {value: capability.value, ...getShippedProvenance({row, sourceUrl: capability.sourceUrl})}
    : null
}

export const resolveProviderModelCapabilities = ({
  metadataJson,
  providerKind,
  remoteModelId,
}: ProviderModelCapabilityModel): ProviderModelCapabilities => {
  const overrides = getProviderModelCapabilityOverrides(metadataJson)
  const discoveredInputSupport = getProviderModelMetadataDiscoveredInputSupport(metadataJson)
  const shippedRow = getProviderModelCapabilityTableRow({providerKind, remoteModelId})

  return {
    contextWindow:
      getUserContextWindow(overrides)
      ?? getDiscoveredContextWindow(metadataJson)
      ?? getShippedContextWindow(shippedRow),
    supportsImageInput:
      getUserBoolean({updatedAt: overrides.updatedAt, value: overrides.supportsImageInput})
      ?? getDiscoveredBoolean(discoveredInputSupport.supportsImageInput)
      ?? getShippedBoolean({capability: shippedRow?.supportsImageInput, row: shippedRow}),
    supportsPdfInput:
      getUserBoolean({updatedAt: overrides.updatedAt, value: overrides.supportsPdfInput})
      ?? getDiscoveredBoolean(discoveredInputSupport.supportsPdfInput)
      ?? getShippedBoolean({capability: shippedRow?.supportsPdfInput, row: shippedRow}),
  }
}

const getPromptTokenLimit = ({
  contextWindow,
  reservedCompletionTokens,
}: {
  contextWindow: ProviderModelContextWindowCapability
  reservedCompletionTokens: number
}): number => {
  return contextWindow.inputTokens ?? Math.max(0, (contextWindow.totalTokens ?? 0) - reservedCompletionTokens)
}

export const getProviderModelContextLimits = ({
  model,
  reservedCompletionTokens,
}: {
  model: ProviderModelCapabilityModel
  reservedCompletionTokens: number
}): {contextLimit: number | null; promptTokenLimit: number | null} => {
  const contextWindow = resolveProviderModelCapabilities(model).contextWindow

  return contextWindow
    ? {
        contextLimit: contextWindow.totalTokens ?? contextWindow.inputTokens,
        promptTokenLimit: getPromptTokenLimit({contextWindow, reservedCompletionTokens}),
      }
    : {contextLimit: null, promptTokenLimit: null}
}

export const getModelContextWindowMissingError = ({
  model,
  modelName,
  providerConnectionId,
}: {
  model: ProviderModelCapabilityModel
  modelName: string
  providerConnectionId: string | null
}): ModelContextWindowMissingError | null => {
  return resolveProviderModelCapabilities(model).contextWindow
    ? null
    : new ModelContextWindowMissingError({modelName, providerConnectionId, providerKind: model.providerKind})
}

export const getModelContext = ({
  model,
  modelName,
  providerConnectionId,
  reservedCompletionTokens,
}: {
  model: ProviderModelCapabilityModel
  modelName: string
  providerConnectionId: string | null
  reservedCompletionTokens: number
}): number => {
  const contextWindow = resolveProviderModelCapabilities(model).contextWindow

  if (!contextWindow) {
    throw new ModelContextWindowMissingError({modelName, providerConnectionId, providerKind: model.providerKind})
  }

  return getPromptTokenLimit({contextWindow, reservedCompletionTokens})
}

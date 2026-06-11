import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import type {ProviderModelOptions} from '../../../utils/providerModelOptions.ts'
import {getResolvedProviderBaseURL} from '../../providers/providerConnectionHelpers.ts'
import {
  getProviderModelMetadataContextLength,
  getProviderModelMetadataOptions,
  getProviderModelMetadataPromptTokenLimit,
} from '../../providers/providerModelMetadata.ts'
import {getProviderRegistryEntry} from '../../providers/providerRegistry.ts'
import type {ProviderConnectionForAdmin, ProviderTransportFamily} from '../../providers/providerTypes.ts'
import {getDefaultWorkerUrlMode} from '../../providers/providerWorkerUtils.ts'
import {getJsonValue} from '../appQueryHelpers.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {normalizeProjectTransferModelVariant} from './projectTransferPayloadSchemas.ts'

export type ProjectTransferProviderSnapshotFingerprintInput = {
  authMode: unknown
  baseURL: string | null
  configJson?: unknown
  providerKind: string
  targetConfig?: ProviderConnectionForAdmin['config']
}

export type ProjectTransferModelSnapshotFingerprintInput = {
  displayName: string | null
  metadataJson: unknown
  modelName: string | null
  name: string
  provider: ProjectTransferProviderSnapshotFingerprintInput
  remoteModelId: string | null
  variant: string | null
  version: string | null
}

export type ProjectTransferProviderSnapshotFingerprint = {
  authMode: string | null
  endpointIdentity: string | null
  providerKind: string
  runtimeMode: {llamaCppMode: string | null; workerUrlMode: string | null}
  transportFamily: ProviderTransportFamily | null
}

export type ProjectTransferModelSnapshotFingerprint = {
  model: {
    contextLimit: number
    displayName: string | null
    modelName: string | null
    modelOptions: ProviderModelOptions
    name: string
    promptTokenLimit: number
    remoteModelId: string | null
    variant: string | null
    version: string | null
  }
  provider: ProjectTransferProviderSnapshotFingerprint
}

const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getConfigRecord = (value: unknown): Record<string, unknown> => {
  const parsed = getJsonValue(value)

  return isRecord(parsed) ? parsed : {}
}

const getStringValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const getAuthModeIdentity = (value: unknown): string | null => {
  const normalized = getStringValue(value)

  return normalized === null ? null : normalized.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '')
}

const isLocalEndpointHostname = (hostname: string) => {
  const normalized = hostname.toLocaleLowerCase('en-US')

  return (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1'
    || normalized.endsWith('.local')
    || normalized.startsWith('127.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  )
}

const getEndpointIdentity = ({baseURL, providerKind}: {baseURL: string | null; providerKind: string}) => {
  const resolvedBaseURL = getResolvedProviderBaseURL({baseURL, providerKind})

  if (resolvedBaseURL === null) {
    return null
  }

  try {
    const url = new URL(resolvedBaseURL)
    const pathname = url.pathname.replace(/\/+$/g, '')

    return isLocalEndpointHostname(url.hostname)
      ? null
      : `${url.protocol.toLocaleLowerCase()}//${url.host.toLocaleLowerCase()}${pathname}`
  } catch {
    return resolvedBaseURL.trim().toLocaleLowerCase('en-US')
  }
}

const getSourceConfigSignature = ({providerKind, value}: {providerKind: string; value: unknown}) => {
  const record = getConfigRecord(value)

  return {
    llamaCppMode: getStringValue(record.llamaCppMode),
    workerUrlMode:
      getStringValue(record.workerUrlMode) ?? getDefaultWorkerUrlMode({manualWorkerUrls: [], providerKind}),
  }
}

const getTargetConfigSignature = (config: ProviderConnectionForAdmin['config']) => {
  return {llamaCppMode: getStringValue(config.llamaCppMode), workerUrlMode: getStringValue(config.workerUrlMode)}
}

export const getProjectTransferProviderSnapshotFingerprint = (
  provider: ProjectTransferProviderSnapshotFingerprintInput,
): ProjectTransferProviderSnapshotFingerprint => {
  const configSignature =
    provider.targetConfig === undefined
      ? getSourceConfigSignature({providerKind: provider.providerKind, value: provider.configJson})
      : getTargetConfigSignature(provider.targetConfig)

  return {
    authMode: getAuthModeIdentity(provider.authMode),
    endpointIdentity: getEndpointIdentity({baseURL: provider.baseURL, providerKind: provider.providerKind}),
    providerKind: provider.providerKind,
    runtimeMode: {llamaCppMode: configSignature.llamaCppMode, workerUrlMode: configSignature.workerUrlMode},
    transportFamily: getProviderRegistryEntry(provider.providerKind)?.transportFamily ?? null,
  }
}

export const getProjectTransferModelSnapshotFingerprint = (
  model: ProjectTransferModelSnapshotFingerprintInput,
): ProjectTransferModelSnapshotFingerprint => {
  const metadataJson = getJsonValue(model.metadataJson)
  const promptTokenLimit =
    getProviderModelMetadataPromptTokenLimit(metadataJson, MAX_COMPLETION_TOKENS) ?? defaultJudgmentPromptTokenLimit

  return {
    model: {
      contextLimit: getProviderModelMetadataContextLength(metadataJson) ?? defaultJudgmentModelContext,
      displayName: model.displayName,
      modelName: model.modelName,
      modelOptions: getProviderModelMetadataOptions(metadataJson),
      name: model.name,
      promptTokenLimit,
      remoteModelId: model.remoteModelId,
      variant: normalizeProjectTransferModelVariant(model.variant),
      version:
        normalizeProjectTransferModelVariant(model.version) ?? normalizeProjectTransferModelVariant(model.variant),
    },
    provider: getProjectTransferProviderSnapshotFingerprint(model.provider),
  }
}

export const projectTransferSnapshotFingerprintsEqual = (left: unknown, right: unknown) => {
  return getProjectTransferCanonicalJson(left) === getProjectTransferCanonicalJson(right)
}

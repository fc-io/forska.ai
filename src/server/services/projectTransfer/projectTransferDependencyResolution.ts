import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import {getResolvedProviderBaseURL} from '../../providers/providerConnectionHelpers.ts'
import {getProviderConnection, listProviderConnections} from '../../providers/providerConnectionRepository.ts'
import {
  getProviderModelMetadataContextLength,
  getProviderModelMetadataOptions,
  getProviderModelMetadataPromptTokenLimit,
} from '../../providers/providerModelMetadata.ts'
import {getProviderModels} from '../../providers/providerModelRepository.ts'
import {getProviderRegistryEntry} from '../../providers/providerRegistry.ts'
import type {
  ProviderConnectionForAdmin,
  ProviderConnectionRecord,
  ProviderModelRecord,
  ProviderTransportFamily,
} from '../../providers/providerTypes.ts'
import {getDefaultWorkerUrlMode} from '../../providers/providerWorkerUtils.ts'
import {getJsonValue} from '../appQueryHelpers.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {
  ProjectTransferDependencyStatus,
  ProjectTransferPlanBlocker,
  ProjectTransferPlanSummary,
} from './projectTransferContracts.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {
  normalizeProjectTransferModelVariant,
  parseProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import type {ProjectTransferImportTempLayout} from './projectTransferSession.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

export type ProjectTransferDependencyProviderSelection = {
  sourceProviderConnectionId: string
  targetProviderConnectionId: string
}

export type ProjectTransferDependencyCreatedProviderHandoff = ProjectTransferDependencyProviderSelection & {
  setupState?: 'auth_pending' | 'complete' | 'connection_test_pending' | 'discovery_pending'
}

export type ProjectTransferDependencyModelSelection = {
  acceptSubstitute?: boolean
  sourceModelId: string
  targetModelId: string
}

export type ProjectTransferDependencyMaterializedModelHandoff = ProjectTransferDependencyModelSelection & {
  targetProviderConnectionId?: string
}

export type ProjectTransferDependencyModelMaterializationRequest = {
  displayName?: string
  remoteModelId: string
  sourceModelId: string
  targetProviderConnectionId: string
  variant?: string | null
}

export type ProjectTransferDependencyExplicitUnresolvedProvider = {
  reason?: string
  sourceProviderConnectionId: string
  status?: Exclude<ProjectTransferDependencyStatus, 'not_required' | 'resolved'>
}

export type ProjectTransferDependencyExplicitUnresolvedModel = {
  reason?: string
  sourceModelId: string
  status?: Exclude<ProjectTransferDependencyStatus, 'not_required' | 'resolved'>
}

export type ProjectTransferDependencyCodexSetupState = 'complete' | 'login_pending' | 'not_ready' | 'setup_pending'

export type ProjectTransferDependencyResolutionRequest = {
  autoResolve?: boolean
  codexSetupState?: ProjectTransferDependencyCodexSetupState
  createdProviderConnections?: ProjectTransferDependencyCreatedProviderHandoff[]
  materializedModels?: ProjectTransferDependencyMaterializedModelHandoff[]
  modelMaterializationRequests?: ProjectTransferDependencyModelMaterializationRequest[]
  planRevision: number
  selectedModels?: ProjectTransferDependencyModelSelection[]
  selectedProviderConnections?: ProjectTransferDependencyProviderSelection[]
  unresolvedModels?: ProjectTransferDependencyExplicitUnresolvedModel[]
  unresolvedProviders?: ProjectTransferDependencyExplicitUnresolvedProvider[]
}

export type ProjectTransferDependencyResolutionState = {
  acceptedSubstituteModelSourceIds: string[]
  codexSetupState: ProjectTransferDependencyCodexSetupState | null
  modelMaterializationRequests: ProjectTransferDependencyModelMaterializationRequest[]
  modelTargetBySourceId: Record<string, string>
  providerTargetBySourceId: Record<string, string>
  unresolvedModelSourceIds: string[]
  unresolvedProviderSourceIds: string[]
}

type ProjectTransferResolvedDependencyPlanArtifact = ProjectTransferImportPlanArtifact & {
  dependencyResolution?: ProjectTransferDependencyResolutionState
}

export type ProjectTransferDependencyResolutionRepositories = {
  getProviderConnectionById?: (id: string) => Promise<ProviderConnectionRecord | null>
  getProviderModelsByIds?: (modelIds: string[]) => Promise<Map<string, ProviderModelRecord>>
  listProviderConnections?: () => Promise<ProviderConnectionForAdmin[]>
}

type ProjectTransferDependencyResolutionInput = RuntimePathOptions & {
  layout: ProjectTransferImportTempLayout
  nextPlanRevision: number
  request: ProjectTransferDependencyResolutionRequest
  repositories?: ProjectTransferDependencyResolutionRepositories
}

export type ProjectTransferDependencyResolutionResult =
  | {
      changed: boolean
      plan: ProjectTransferResolvedDependencyPlanArtifact
      planSummary: ProjectTransferPlanSummary
      status: 'ok'
    }
  | {error: string; status: 'error'; statusCode: number}

type ImportedProviderConnection = ProjectTransferPayloadRecord & {
  authMode: string | null
  baseURL: string | null
  configJson: unknown
  enabled: boolean
  label: string
  providerKind: string
  sourceProviderConnectionId: string
}

type ImportedModel = ProjectTransferPayloadRecord & {
  displayName: string | null
  enabled: boolean
  modelName: string
  name: string
  remoteModelId: string | null
  sourceModelId: string
  sourceProviderConnectionId: string
  variant: string | null
  version: string | null
}

type ImportedJudgment = ProjectTransferPayloadRecord & {judgmentInputSignature?: unknown; sourceModelId: string}

type ProviderEquivalenceFingerprint = {
  authMode: string | null
  endpointIdentity: string | null
  providerKind: string
  runtimeMode: {llamaCppMode: string | null; workerUrlMode: string | null}
  sourceConfig: {llamaCppMode: string | null; workerUrlMode: string | null}
  transportFamily: ProviderTransportFamily | null
}

type DependencyBlockerInput = {code: string; message: string; scope: string}

const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)
const dependencyScopePrefix = 'dependencies.'

const getRepositories = (repositories?: ProjectTransferDependencyResolutionRepositories) => {
  return {
    getProviderConnectionById: repositories?.getProviderConnectionById ?? getProviderConnection,
    getProviderModelsByIds: repositories?.getProviderModelsByIds ?? getProviderModels,
    listProviderConnections: repositories?.listProviderConnections ?? listProviderConnections,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const getNullableStringValue = (value: unknown): string | null => {
  return value === null ? null : getStringValue(value)
}

const getAuthModeIdentity = (value: unknown): string | null => {
  const normalized = getStringValue(value)

  return normalized === null ? null : normalized.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '')
}

const getBooleanValue = (value: unknown): boolean => {
  return typeof value === 'boolean' ? value : false
}

const normalizeComparableString = (value: unknown): string | null => {
  const normalized = getStringValue(value)

  return normalized === null ? null : normalized.toLocaleLowerCase('en-US')
}

const getProviderRegistryTransportFamily = (
  providerKind: string | null | undefined,
): ProviderTransportFamily | null => {
  return getProviderRegistryEntry(providerKind)?.transportFamily ?? null
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

const getConfigRecord = (value: unknown): Record<string, unknown> => {
  const parsed = getJsonValue(value)

  return isRecord(parsed) ? parsed : {}
}

const getSourceConfigSignature = ({providerKind, value}: {providerKind: string; value: unknown}) => {
  const record = getConfigRecord(value)

  return {
    llamaCppMode: getStringValue(record.llamaCppMode),
    workerUrlMode:
      getStringValue(record.workerUrlMode) ?? getDefaultWorkerUrlMode({manualWorkerUrls: [], providerKind}),
  }
}

const getTargetConfigSignature = (connection: ProviderConnectionForAdmin | ProviderConnectionRecord) => {
  return {
    llamaCppMode: getStringValue(connection.config.llamaCppMode),
    workerUrlMode: getStringValue(connection.config.workerUrlMode),
  }
}

const getProviderFingerprint = (
  provider: ImportedProviderConnection | ProviderConnectionForAdmin | ProviderConnectionRecord,
): ProviderEquivalenceFingerprint => {
  const importedSignature =
    'sourceProviderConnectionId' in provider && isRecord(provider.signature) ? provider.signature : null
  const providerKind = getStringValue(importedSignature?.providerKind) ?? provider.providerKind
  const baseURL =
    'sourceProviderConnectionId' in provider
      ? (getNullableStringValue(importedSignature?.baseURL) ?? provider.baseURL)
      : provider.baseURL
  const configSignature =
    'sourceProviderConnectionId' in provider
      ? getSourceConfigSignature({providerKind, value: importedSignature?.configSignature ?? provider.configJson})
      : getTargetConfigSignature(provider)

  return {
    authMode: getAuthModeIdentity(
      'sourceProviderConnectionId' in provider ? (importedSignature?.authMode ?? provider.authMode) : provider.authMode,
    ),
    endpointIdentity: getEndpointIdentity({baseURL, providerKind}),
    providerKind,
    runtimeMode: {llamaCppMode: configSignature.llamaCppMode, workerUrlMode: configSignature.workerUrlMode},
    sourceConfig: configSignature,
    transportFamily: getProviderRegistryTransportFamily(providerKind),
  }
}

const providerFingerprintsMatch = (
  sourceProvider: ImportedProviderConnection,
  targetProvider: ProviderConnectionForAdmin,
) => {
  return (
    getProjectTransferCanonicalJson(getProviderFingerprint(sourceProvider))
    === getProjectTransferCanonicalJson(getProviderFingerprint(targetProvider))
  )
}

const getPayloadPath = (layout: ProjectTransferImportTempLayout, key: keyof ProjectTransferPayloadByKey) => {
  return `${layout.extractedPath}/${projectTransferPayloadPathByKey[key]}`
}

const readTextArtifact = async (input: RuntimePathOptions & {pathValue: string}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath(input)
  const file = globalThis.Bun.file(resolvedPath)

  return (await file.exists()) ? file.text() : null
}

const readJsonArtifact = async <TValue>(input: RuntimePathOptions & {pathValue: string}): Promise<TValue | null> => {
  const text = await readTextArtifact(input)

  return text === null ? null : (JSON.parse(text) as TValue)
}

const readExtractedPayload = async <TKey extends keyof ProjectTransferPayloadByKey>(
  input: RuntimePathOptions & {key: TKey; layout: ProjectTransferImportTempLayout},
) => {
  const text = await readTextArtifact({...input, pathValue: getPayloadPath(input.layout, input.key)})

  return text === null ? null : parseProjectTransferPayload(input.key, text)
}

const writeJsonArtifact = async (input: RuntimePathOptions & {pathValue: string; value: unknown}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath(input)
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(input.value))
}

const getImportedProviderConnection = (record: ProjectTransferPayloadRecord): ImportedProviderConnection => {
  return {
    ...record,
    authMode: getNullableStringValue(record.authMode),
    baseURL: getNullableStringValue(record.baseURL),
    configJson: record.configJson ?? null,
    enabled: getBooleanValue(record.enabled),
    label: getStringValue(record.label) ?? 'Imported provider',
    providerKind: getStringValue(record.providerKind) ?? 'unknown',
    sourceProviderConnectionId: getStringValue(record.sourceProviderConnectionId) ?? '',
  }
}

const getImportedModel = (record: ProjectTransferPayloadRecord): ImportedModel => {
  return {
    ...record,
    displayName: getNullableStringValue(record.displayName),
    enabled: getBooleanValue(record.enabled),
    modelName: getStringValue(record.modelName) ?? '',
    name: getStringValue(record.name) ?? '',
    remoteModelId: getNullableStringValue(record.remoteModelId),
    sourceModelId: getStringValue(record.sourceModelId) ?? '',
    sourceProviderConnectionId: getStringValue(record.sourceProviderConnectionId) ?? '',
    variant: normalizeProjectTransferModelVariant(record.variant),
    version: normalizeProjectTransferModelVariant(record.version),
  }
}

const getImportedJudgment = (record: ProjectTransferPayloadRecord): ImportedJudgment => {
  return {...record, sourceModelId: getStringValue(record.sourceModelId) ?? ''}
}

const getStringArray = (record: Record<string, unknown>, key: string) => {
  const value = record[key]

  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const getStringRecord = (record: Record<string, unknown>, key: string) => {
  const value = record[key]

  return isRecord(value)
    ? Object.entries(value).reduce<Record<string, string>>((mapped, [sourceId, targetId]) => {
        return typeof targetId === 'string' ? {...mapped, [sourceId]: targetId} : mapped
      }, {})
    : {}
}

const getModelMaterializationRequests = (
  record: Record<string, unknown>,
): ProjectTransferDependencyModelMaterializationRequest[] => {
  const value = record.modelMaterializationRequests

  return Array.isArray(value) ? (value as ProjectTransferDependencyModelMaterializationRequest[]) : []
}

const getCodexSetupState = (record: Record<string, unknown>): ProjectTransferDependencyCodexSetupState | null => {
  const value = record.codexSetupState

  return value === 'complete' || value === 'login_pending' || value === 'not_ready' || value === 'setup_pending'
    ? value
    : null
}

const getPlanDependencyResolution = (
  plan: ProjectTransferResolvedDependencyPlanArtifact,
): ProjectTransferDependencyResolutionState => {
  const existing = isRecord(plan.dependencyResolution) ? plan.dependencyResolution : {}

  return {
    acceptedSubstituteModelSourceIds: getStringArray(existing, 'acceptedSubstituteModelSourceIds'),
    codexSetupState: getCodexSetupState(existing),
    modelMaterializationRequests: getModelMaterializationRequests(existing),
    modelTargetBySourceId: getStringRecord(existing, 'modelTargetBySourceId'),
    providerTargetBySourceId: getStringRecord(existing, 'providerTargetBySourceId'),
    unresolvedModelSourceIds: getStringArray(existing, 'unresolvedModelSourceIds'),
    unresolvedProviderSourceIds: getStringArray(existing, 'unresolvedProviderSourceIds'),
  }
}

const getNextResolutionState = (
  previous: ProjectTransferDependencyResolutionState,
  request: ProjectTransferDependencyResolutionRequest,
): ProjectTransferDependencyResolutionState => {
  const providerSelections = [
    ...(request.selectedProviderConnections ?? []),
    ...(request.createdProviderConnections ?? []),
  ]
  const modelSelections = [...(request.selectedModels ?? []), ...(request.materializedModels ?? [])]
  const unresolvedProviderIds = new Set([
    ...previous.unresolvedProviderSourceIds,
    ...(request.unresolvedProviders ?? []).map((entry) => {
      return entry.sourceProviderConnectionId
    }),
  ])
  const unresolvedModelIds = new Set([
    ...previous.unresolvedModelSourceIds,
    ...(request.unresolvedModels ?? []).map((entry) => {
      return entry.sourceModelId
    }),
  ])
  const providerTargetBySourceId = providerSelections.reduce<Record<string, string>>((mapped, selection) => {
    unresolvedProviderIds.delete(selection.sourceProviderConnectionId)

    return {...mapped, [selection.sourceProviderConnectionId]: selection.targetProviderConnectionId}
  }, previous.providerTargetBySourceId)
  const modelTargetBySourceId = modelSelections.reduce<Record<string, string>>((mapped, selection) => {
    unresolvedModelIds.delete(selection.sourceModelId)

    return {...mapped, [selection.sourceModelId]: selection.targetModelId}
  }, previous.modelTargetBySourceId)
  const filteredProviderTargetBySourceId = Object.entries(providerTargetBySourceId).reduce<Record<string, string>>(
    (mapped, [sourceId, targetId]) => {
      return unresolvedProviderIds.has(sourceId) ? mapped : {...mapped, [sourceId]: targetId}
    },
    {},
  )
  const filteredModelTargetBySourceId = Object.entries(modelTargetBySourceId).reduce<Record<string, string>>(
    (mapped, [sourceId, targetId]) => {
      return unresolvedModelIds.has(sourceId) ? mapped : {...mapped, [sourceId]: targetId}
    },
    {},
  )
  const acceptedSubstituteModelSourceIds = Array.from(
    new Set([
      ...previous.acceptedSubstituteModelSourceIds,
      ...modelSelections.flatMap((selection) => {
        return selection.acceptSubstitute ? [selection.sourceModelId] : []
      }),
    ]),
  )

  return {
    acceptedSubstituteModelSourceIds,
    codexSetupState: request.codexSetupState ?? previous.codexSetupState,
    modelMaterializationRequests: request.modelMaterializationRequests ?? previous.modelMaterializationRequests,
    modelTargetBySourceId: filteredModelTargetBySourceId,
    providerTargetBySourceId: filteredProviderTargetBySourceId,
    unresolvedModelSourceIds: Array.from(unresolvedModelIds),
    unresolvedProviderSourceIds: Array.from(unresolvedProviderIds),
  }
}

const getProviderDependencyKey = (sourceProviderConnectionId: string) => {
  return `provider:${sourceProviderConnectionId}`
}

const getModelDependencyKey = (sourceModelId: string) => {
  return `model:${sourceModelId}`
}

const isVirtualSelectableModelId = (modelId: string) => {
  return modelId.startsWith('codex:') || modelId.startsWith('anthropic:')
}

const getDependencyBlocker = ({code, message, scope}: DependencyBlockerInput): ProjectTransferPlanBlocker => {
  return {code, message, resolutionKind: 'wizard_resolvable', scope}
}

const isDependencyBlocker = (blocker: ProjectTransferPlanBlocker) => {
  return blocker.scope.startsWith(dependencyScopePrefix) || blocker.code.startsWith('dependency_')
}

const getBasePlanBlockers = (plan: ProjectTransferResolvedDependencyPlanArtifact) => {
  return (plan.blockers ?? []).filter((blocker) => {
    return !isDependencyBlocker(blocker)
  })
}

const getModelsBySourceProviderId = (models: ImportedModel[]) => {
  return models.reduce<Record<string, ImportedModel[]>>((mapped, model) => {
    const existing = mapped[model.sourceProviderConnectionId] ?? []

    return {...mapped, [model.sourceProviderConnectionId]: [...existing, model]}
  }, {})
}

const getJudgmentModelSourceIds = (judgments: ImportedJudgment[]) => {
  return new Set(
    judgments.flatMap((judgment) => {
      return judgment.sourceModelId ? [judgment.sourceModelId] : []
    }),
  )
}

const getJudgmentModelSignaturesBySourceId = (judgments: ImportedJudgment[]) => {
  return judgments.reduce<Record<string, unknown[]>>((mapped, judgment) => {
    const signature = isRecord(judgment.judgmentInputSignature) ? judgment.judgmentInputSignature.model : null
    const existing = mapped[judgment.sourceModelId] ?? []

    return signature ? {...mapped, [judgment.sourceModelId]: [...existing, signature]} : mapped
  }, {})
}

const getSelectableConnectionModels = (connection: ProviderConnectionForAdmin) => {
  return connection.models.filter((model) => {
    return model.enabled && model.providerConnectionId === connection.id
  })
}

const modelVariantMatches = (source: ImportedModel, target: ProviderModelRecord) => {
  return (
    normalizeProjectTransferModelVariant(source.variant) === normalizeProjectTransferModelVariant(target.variant)
    && normalizeProjectTransferModelVariant(source.version) === normalizeProjectTransferModelVariant(target.version)
  )
}

const remoteModelMatches = (source: ImportedModel, target: ProviderModelRecord) => {
  return (
    source.remoteModelId !== null
    && normalizeComparableString(target.remoteModelId) === normalizeComparableString(source.remoteModelId)
    && modelVariantMatches(source, target)
  )
}

const nullableRemoteModelMatches = (source: ImportedModel, target: ProviderModelRecord) => {
  return (
    source.remoteModelId === null
    && normalizeComparableString(target.remoteModelId) === null
    && normalizeComparableString(target.modelName) === normalizeComparableString(source.modelName)
    && normalizeComparableString(target.name) === normalizeComparableString(source.name)
    && normalizeComparableString(target.displayName) === normalizeComparableString(source.displayName)
    && modelVariantMatches(source, target)
  )
}

const getSourceModelIdentityCandidates = (source: ImportedModel, connection: ProviderConnectionForAdmin) => {
  return getSelectableConnectionModels(connection).filter((target) => {
    return remoteModelMatches(source, target) || nullableRemoteModelMatches(source, target)
  })
}

const getTargetModelRequestSignature = (model: ProviderModelRecord) => {
  return {
    contextLimit: getProviderModelMetadataContextLength(model.metadataJson) ?? defaultJudgmentModelContext,
    modelOptions: getProviderModelMetadataOptions(model.metadataJson),
    promptTokenLimit:
      getProviderModelMetadataPromptTokenLimit(model.metadataJson, MAX_COMPLETION_TOKENS)
      ?? defaultJudgmentPromptTokenLimit,
  }
}

const targetModelRequestMatches = (sourceSignatures: unknown[], target: ProviderModelRecord) => {
  if (sourceSignatures.length === 0) {
    return true
  }

  const targetSignature = getTargetModelRequestSignature(target)

  return sourceSignatures.every((signature) => {
    if (!isRecord(signature)) {
      return false
    }

    return (
      signature.contextLimit === targetSignature.contextLimit
      && getProjectTransferCanonicalJson(signature.modelOptions ?? null)
        === getProjectTransferCanonicalJson(targetSignature.modelOptions)
      && signature.promptTokenLimit === targetSignature.promptTokenLimit
    )
  })
}

const targetModelEquivalentForImportedJudgments = ({
  judgmentModelSignaturesBySourceId,
  sourceModel,
  targetModel,
}: {
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  sourceModel: ImportedModel
  targetModel: ProviderModelRecord
}) => {
  return (
    (remoteModelMatches(sourceModel, targetModel) || nullableRemoteModelMatches(sourceModel, targetModel))
    && targetModelRequestMatches(judgmentModelSignaturesBySourceId[sourceModel.sourceModelId] ?? [], targetModel)
  )
}

const getUniqueEquivalentTargetModel = ({
  connection,
  judgmentModelSignaturesBySourceId,
  sourceModel,
}: {
  connection: ProviderConnectionForAdmin
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  sourceModel: ImportedModel
}) => {
  const candidates = getSourceModelIdentityCandidates(sourceModel, connection).filter((targetModel) => {
    return targetModelEquivalentForImportedJudgments({judgmentModelSignaturesBySourceId, sourceModel, targetModel})
  })

  return candidates.length === 1 ? candidates[0] : null
}

const connectionHasSelectableRequiredModels = ({
  connection,
  judgmentModelSignaturesBySourceId,
  sourceModels,
}: {
  connection: ProviderConnectionForAdmin
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  sourceModels: ImportedModel[]
}) => {
  return sourceModels.every((sourceModel) => {
    return getUniqueEquivalentTargetModel({connection, judgmentModelSignaturesBySourceId, sourceModel}) !== null
  })
}

const getAutoMatchedProviderConnection = ({
  connections,
  importedProvider,
  judgmentModelSignaturesBySourceId,
  sourceModels,
}: {
  connections: ProviderConnectionForAdmin[]
  importedProvider: ImportedProviderConnection
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  sourceModels: ImportedModel[]
}) => {
  const candidates = connections.filter((connection) => {
    return (
      connection.enabled
      && !connection.config.archived
      && providerFingerprintsMatch(importedProvider, connection)
      && connectionHasSelectableRequiredModels({connection, judgmentModelSignaturesBySourceId, sourceModels})
    )
  })

  return candidates.length === 1 ? candidates[0] : null
}

const getConnectionById = (connections: ProviderConnectionForAdmin[]) => {
  return connections.reduce<Record<string, ProviderConnectionForAdmin>>((mapped, connection) => {
    return {...mapped, [connection.id]: connection}
  }, {})
}

const requireListedEnabledConnection = async ({
  connectionById,
  getProviderConnectionById,
  targetProviderConnectionId,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  getProviderConnectionById: (id: string) => Promise<ProviderConnectionRecord | null>
  targetProviderConnectionId: string
}) => {
  const listed = connectionById[targetProviderConnectionId] ?? null

  if (listed !== null && listed.enabled && !listed.config.archived) {
    return {connection: listed, ok: true as const}
  }

  const stored = await getProviderConnectionById(targetProviderConnectionId)
  const archived = stored?.config.archived === true
  const message =
    stored === null
      ? `Target provider connection ${targetProviderConnectionId} is not listed`
      : archived
        ? `Target provider connection ${targetProviderConnectionId} is archived`
        : `Target provider connection ${targetProviderConnectionId} is disabled or hidden`

  return {error: message, ok: false as const}
}

const validateExplicitProviderSelections = async ({
  connectionById,
  getProviderConnectionById,
  resolutionState,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  getProviderConnectionById: (id: string) => Promise<ProviderConnectionRecord | null>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  const invalid = await Object.values(resolutionState.providerTargetBySourceId).reduce<
    Promise<{error: string; ok: false} | {ok: true}>
  >(
    async (previous, targetProviderConnectionId) => {
      const previousResult = await previous

      if (!previousResult.ok) {
        return previousResult
      }

      return requireListedEnabledConnection({connectionById, getProviderConnectionById, targetProviderConnectionId})
    },
    Promise.resolve({ok: true as const}),
  )

  return invalid.ok ? null : invalid.error
}

const validateExplicitModelSelections = async ({
  getProviderModelsByIds,
  resolutionState,
}: {
  getProviderModelsByIds: (modelIds: string[]) => Promise<Map<string, ProviderModelRecord>>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  const targetModelIds = Array.from(new Set(Object.values(resolutionState.modelTargetBySourceId)))
  const virtualTargetModelId =
    targetModelIds.find((targetModelId) => {
      return isVirtualSelectableModelId(targetModelId)
    }) ?? null

  if (virtualTargetModelId !== null) {
    return `Target model ${virtualTargetModelId} is a virtual selectable model id and must be materialized first`
  }

  const targetModels = await getProviderModelsByIds(targetModelIds)
  const invalidTargetModelId = targetModelIds.find((targetModelId) => {
    const targetModel = targetModels.get(targetModelId)

    return !targetModel || !targetModel.enabled || !targetModel.providerConnectionId
  })

  return invalidTargetModelId ? `Target model ${invalidTargetModelId} is not selectable` : null
}

const getResolvedProviderMappings = ({
  autoResolve,
  connections,
  importedProviders,
  judgmentModelSignaturesBySourceId,
  modelsBySourceProviderId,
  resolutionState,
}: {
  autoResolve: boolean
  connections: ProviderConnectionForAdmin[]
  importedProviders: ImportedProviderConnection[]
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  modelsBySourceProviderId: Record<string, ImportedModel[]>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  return importedProviders.reduce<Record<string, string>>((mapped, importedProvider) => {
    const sourceProviderConnectionId = importedProvider.sourceProviderConnectionId
    const existingTargetId = mapped[sourceProviderConnectionId]
    const sourceModels = modelsBySourceProviderId[sourceProviderConnectionId] ?? []
    const autoMatched =
      existingTargetId
      || resolutionState.unresolvedProviderSourceIds.includes(sourceProviderConnectionId)
      || !autoResolve
        ? null
        : getAutoMatchedProviderConnection({
            connections,
            importedProvider,
            judgmentModelSignaturesBySourceId,
            sourceModels,
          })

    return autoMatched ? {...mapped, [sourceProviderConnectionId]: autoMatched.id} : mapped
  }, resolutionState.providerTargetBySourceId)
}

const getResolvedModelMappings = ({
  connectionById,
  importedModels,
  judgmentModelSignaturesBySourceId,
  providerTargetBySourceId,
  resolutionState,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  importedModels: ImportedModel[]
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  providerTargetBySourceId: Record<string, string>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  return importedModels.reduce<Record<string, string>>((mapped, importedModel) => {
    const sourceModelId = importedModel.sourceModelId
    const existingTargetId = mapped[sourceModelId]
    const targetProviderConnectionId = providerTargetBySourceId[importedModel.sourceProviderConnectionId]
    const connection = targetProviderConnectionId ? (connectionById[targetProviderConnectionId] ?? null) : null
    const autoMatched =
      existingTargetId || resolutionState.unresolvedModelSourceIds.includes(sourceModelId) || connection === null
        ? null
        : getUniqueEquivalentTargetModel({connection, judgmentModelSignaturesBySourceId, sourceModel: importedModel})

    return autoMatched ? {...mapped, [sourceModelId]: autoMatched.id} : mapped
  }, resolutionState.modelTargetBySourceId)
}

const getProviderStatusesAndBlockers = ({
  connectionById,
  importedProviders,
  providerTargetBySourceId,
  resolutionState,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  importedProviders: ImportedProviderConnection[]
  providerTargetBySourceId: Record<string, string>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  return importedProviders.reduce<{
    blockers: ProjectTransferPlanBlocker[]
    statuses: Record<string, ProjectTransferDependencyStatus>
  }>(
    (result, importedProvider) => {
      const sourceProviderConnectionId = importedProvider.sourceProviderConnectionId
      const targetProviderConnectionId = providerTargetBySourceId[sourceProviderConnectionId]
      const explicitUnresolved = resolutionState.unresolvedProviderSourceIds.includes(sourceProviderConnectionId)
      const targetConnection = targetProviderConnectionId ? (connectionById[targetProviderConnectionId] ?? null) : null
      const equivalentConnection = targetConnection
        ? providerFingerprintsMatch(importedProvider, targetConnection)
        : false
      const status: ProjectTransferDependencyStatus =
        targetConnection && targetConnection.enabled && !targetConnection.config.archived && equivalentConnection
          ? 'resolved'
          : targetConnection
            ? 'blocked'
            : explicitUnresolved
              ? 'missing'
              : 'missing'
      const blocker =
        status === 'resolved'
          ? null
          : getDependencyBlocker({
              code: status === 'blocked' ? 'dependency_provider_not_equivalent' : 'dependency_provider_unresolved',
              message:
                status === 'blocked'
                  ? `Provider dependency ${importedProvider.label} requires an identity-equivalent target connection`
                  : `Provider dependency ${importedProvider.label} requires a listed enabled target connection`,
              scope: `${dependencyScopePrefix}provider.${sourceProviderConnectionId}`,
            })

      return {
        blockers: blocker ? [...result.blockers, blocker] : result.blockers,
        statuses: {...result.statuses, [getProviderDependencyKey(sourceProviderConnectionId)]: status},
      }
    },
    {blockers: [], statuses: {}},
  )
}

const getTargetModelById = (connections: ProviderConnectionForAdmin[]) => {
  return connections
    .flatMap((connection) => {
      return connection.models
    })
    .reduce<Record<string, ProviderModelRecord>>((mapped, model) => {
      return {...mapped, [model.id]: model}
    }, {})
}

const getModelStatus = ({
  acceptedSubstitute,
  importedModel,
  judgmentModelSourceIds,
  judgmentModelSignaturesBySourceId,
  providerTargetBySourceId,
  targetModel,
}: {
  acceptedSubstitute: boolean
  importedModel: ImportedModel
  judgmentModelSourceIds: Set<string>
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  providerTargetBySourceId: Record<string, string>
  targetModel: ProviderModelRecord | null
}): ProjectTransferDependencyStatus => {
  if (!targetModel || !targetModel.enabled || !targetModel.providerConnectionId) {
    return 'missing'
  }

  if (providerTargetBySourceId[importedModel.sourceProviderConnectionId] !== targetModel.providerConnectionId) {
    return 'blocked'
  }

  if (
    targetModelEquivalentForImportedJudgments({
      judgmentModelSignaturesBySourceId,
      sourceModel: importedModel,
      targetModel,
    })
  ) {
    return 'resolved'
  }

  return acceptedSubstitute && !judgmentModelSourceIds.has(importedModel.sourceModelId) ? 'resolved' : 'blocked'
}

const getModelStatusesAndBlockers = ({
  importedModels,
  judgmentModelSignaturesBySourceId,
  judgmentModelSourceIds,
  modelTargetBySourceId,
  providerTargetBySourceId,
  resolutionState,
  targetModelById,
}: {
  importedModels: ImportedModel[]
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  judgmentModelSourceIds: Set<string>
  modelTargetBySourceId: Record<string, string>
  providerTargetBySourceId: Record<string, string>
  resolutionState: ProjectTransferDependencyResolutionState
  targetModelById: Record<string, ProviderModelRecord>
}) => {
  return importedModels.reduce<{
    blockers: ProjectTransferPlanBlocker[]
    statuses: Record<string, ProjectTransferDependencyStatus>
  }>(
    (result, importedModel) => {
      const sourceModelId = importedModel.sourceModelId
      const targetModelId = modelTargetBySourceId[sourceModelId]
      const targetModel = targetModelId ? (targetModelById[targetModelId] ?? null) : null
      const acceptedSubstitute = resolutionState.acceptedSubstituteModelSourceIds.includes(sourceModelId)
      const status = getModelStatus({
        acceptedSubstitute,
        importedModel,
        judgmentModelSignaturesBySourceId,
        judgmentModelSourceIds,
        providerTargetBySourceId,
        targetModel,
      })
      const blocker =
        status === 'resolved'
          ? null
          : getDependencyBlocker({
              code: status === 'blocked' ? 'dependency_model_not_equivalent' : 'dependency_model_unresolved',
              message: `Model dependency ${importedModel.name} requires an enabled identity-equivalent target model`,
              scope: `${dependencyScopePrefix}model.${sourceModelId}`,
            })

      return {
        blockers: blocker ? [...result.blockers, blocker] : result.blockers,
        statuses: {...result.statuses, [getModelDependencyKey(sourceModelId)]: status},
      }
    },
    {blockers: [], statuses: {}},
  )
}

const getResolvedPlanSummary = ({
  dependencyBlockers,
  dependencyStatuses,
  plan,
}: {
  dependencyBlockers: ProjectTransferPlanBlocker[]
  dependencyStatuses: Record<string, ProjectTransferDependencyStatus>
  plan: ProjectTransferResolvedDependencyPlanArtifact
}): ProjectTransferPlanSummary => {
  const blockers = [...getBasePlanBlockers(plan), ...dependencyBlockers]

  return {...plan.summary, blockerCount: blockers.length, blockers, dependencyStatuses}
}

const getCanCommit = (summary: ProjectTransferPlanSummary) => {
  return (
    summary.blockerCount === 0
    && Object.values(summary.dependencyStatuses).every((status) => {
      return status === 'resolved' || status === 'not_required'
    })
  )
}

const getResultChanged = ({
  nextPlan,
  previousPlan,
}: {
  nextPlan: ProjectTransferResolvedDependencyPlanArtifact
  previousPlan: ProjectTransferResolvedDependencyPlanArtifact
}) => {
  const previousComparable = {
    blockers: previousPlan.blockers,
    canCommit: previousPlan.canCommit,
    dependencyResolution: previousPlan.dependencyResolution ?? null,
    summary: previousPlan.summary,
  }
  const nextComparable = {
    blockers: nextPlan.blockers,
    canCommit: nextPlan.canCommit,
    dependencyResolution: nextPlan.dependencyResolution ?? null,
    summary: nextPlan.summary,
  }

  return getProjectTransferCanonicalJson(previousComparable) !== getProjectTransferCanonicalJson(nextComparable)
}

const getResolvedPlan = ({
  dependencyResolution,
  dependencySummary,
  nextPlanRevision,
  previousPlan,
}: {
  dependencyResolution: ProjectTransferDependencyResolutionState
  dependencySummary: ProjectTransferPlanSummary
  nextPlanRevision: number
  previousPlan: ProjectTransferResolvedDependencyPlanArtifact
}): ProjectTransferResolvedDependencyPlanArtifact => {
  return {
    ...previousPlan,
    blockers: dependencySummary.blockers ?? [],
    canCommit: getCanCommit(dependencySummary),
    dependencyResolution,
    planRevision: nextPlanRevision,
    resolutionKinds: (dependencySummary.blockers ?? []).reduce<
      Record<string, ProjectTransferPlanBlocker['resolutionKind']>
    >((mapped, blocker) => {
      return {...mapped, [blocker.code]: blocker.resolutionKind}
    }, {}),
    summary: dependencySummary,
  }
}

export const resolveProjectTransferDependencies = async (
  input: ProjectTransferDependencyResolutionInput,
): Promise<ProjectTransferDependencyResolutionResult> => {
  const repositories = getRepositories(input.repositories)
  const plan = await readJsonArtifact<ProjectTransferResolvedDependencyPlanArtifact>({
    ...input,
    pathValue: input.layout.planPath,
  })

  if (plan === null) {
    return {error: 'Project transfer import plan artifact is unavailable', status: 'error', statusCode: 409}
  }

  const [providerPayload, modelPayload, judgmentPayload, connections] = await Promise.all([
    readExtractedPayload({...input, key: 'providerConnections'}),
    readExtractedPayload({...input, key: 'models'}),
    readExtractedPayload({...input, key: 'judgments'}),
    repositories.listProviderConnections(),
  ])

  if (providerPayload === null || modelPayload === null || judgmentPayload === null) {
    return {error: 'Project transfer dependency payloads are unavailable', status: 'error', statusCode: 409}
  }

  const connectionById = getConnectionById(connections)
  const previousResolutionState = getPlanDependencyResolution(plan)
  const requestedResolutionState = getNextResolutionState(previousResolutionState, input.request)
  const explicitProviderError = await validateExplicitProviderSelections({
    connectionById,
    getProviderConnectionById: repositories.getProviderConnectionById,
    resolutionState: requestedResolutionState,
  })

  if (explicitProviderError !== null) {
    return {error: explicitProviderError, status: 'error', statusCode: 400}
  }

  const explicitModelError = await validateExplicitModelSelections({
    getProviderModelsByIds: repositories.getProviderModelsByIds,
    resolutionState: requestedResolutionState,
  })

  if (explicitModelError !== null) {
    return {error: explicitModelError, status: 'error', statusCode: 400}
  }

  const importedProviders = providerPayload.map(getImportedProviderConnection)
  const importedModels = modelPayload.map(getImportedModel)
  const importedJudgments = judgmentPayload.map(getImportedJudgment)
  const modelsBySourceProviderId = getModelsBySourceProviderId(importedModels)
  const judgmentModelSourceIds = getJudgmentModelSourceIds(importedJudgments)
  const judgmentModelSignaturesBySourceId = getJudgmentModelSignaturesBySourceId(importedJudgments)
  const providerTargetBySourceId = getResolvedProviderMappings({
    autoResolve: input.request.autoResolve !== false,
    connections,
    importedProviders,
    judgmentModelSignaturesBySourceId,
    modelsBySourceProviderId,
    resolutionState: requestedResolutionState,
  })
  const modelTargetBySourceId = getResolvedModelMappings({
    connectionById,
    importedModels,
    judgmentModelSignaturesBySourceId,
    providerTargetBySourceId,
    resolutionState: requestedResolutionState,
  })
  const dependencyResolution: ProjectTransferDependencyResolutionState = {
    ...requestedResolutionState,
    modelTargetBySourceId,
    providerTargetBySourceId,
  }
  const providerResolution = getProviderStatusesAndBlockers({
    connectionById,
    importedProviders,
    providerTargetBySourceId,
    resolutionState: dependencyResolution,
  })
  const modelResolution = getModelStatusesAndBlockers({
    importedModels,
    judgmentModelSignaturesBySourceId,
    judgmentModelSourceIds,
    modelTargetBySourceId,
    providerTargetBySourceId,
    resolutionState: dependencyResolution,
    targetModelById: getTargetModelById(connections),
  })
  const planSummary = getResolvedPlanSummary({
    dependencyBlockers: [...providerResolution.blockers, ...modelResolution.blockers],
    dependencyStatuses: {...providerResolution.statuses, ...modelResolution.statuses},
    plan,
  })
  const nextPlan = getResolvedPlan({
    dependencyResolution,
    dependencySummary: planSummary,
    nextPlanRevision: input.nextPlanRevision,
    previousPlan: plan,
  })
  const changed = getResultChanged({nextPlan, previousPlan: plan})
  const finalPlan = changed ? nextPlan : plan

  if (changed) {
    await writeJsonArtifact({...input, pathValue: input.layout.planPath, value: nextPlan})
  }

  return {changed, plan: finalPlan, planSummary: finalPlan.summary, status: 'ok'}
}

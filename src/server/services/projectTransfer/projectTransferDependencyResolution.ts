import {MAX_COMPLETION_TOKENS} from '../../../agent/judge.ts'
import type {ProviderModelOptions} from '../../../utils/providerModelOptions.ts'
import {ensureCodexProviderModel} from '../../providers/ensureCodexProviderModel.ts'
import {getProviderConnection, listProviderConnections} from '../../providers/providerConnectionRepository.ts'
import {
  getProviderModelMetadataContextLength,
  getProviderModelMetadataOptions,
  getProviderModelMetadataPromptTokenLimit,
} from '../../providers/providerModelMetadata.ts'
import {getProviderModels} from '../../providers/providerModelRepository.ts'
import type {
  ProviderConnectionForAdmin,
  ProviderConnectionRecord,
  ProviderModelRecord,
} from '../../providers/providerTypes.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue} from '../appQueryHelpers.ts'
import type {ProjectTransferImportPlanArtifact} from './projectTransferAnalyze.ts'
import type {ProjectTransferAnalyzeTargetRunner} from './projectTransferAnalyzeTarget.ts'
import type {
  ProjectTransferDependencyStatus,
  ProjectTransferPlanBlocker,
  ProjectTransferPlanSummary,
} from './projectTransferContracts.ts'
import {
  getProjectTransferFidelityValidation,
  isProjectTransferFidelityBlocker,
} from './projectTransferFidelityValidation.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {
  type ProjectTransferOperationTableRunner,
  type ProjectTransferOperationTableSet,
  withProjectTransferOperationTables,
} from './projectTransferOperationTables.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {
  normalizeProjectTransferModelVariant,
  parseProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import type {ProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {
  getProjectTransferModelSnapshotFingerprint,
  getProjectTransferProviderSnapshotFingerprint,
  projectTransferSnapshotFingerprintsEqual,
} from './projectTransferSnapshotFingerprint.ts'

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
  options?: ProviderModelOptions
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
  analyzeTargetRunner?: ProjectTransferAnalyzeTargetRunner | null
  ensureCodexProviderModel?: (input: {
    modelName: string
    name: string
    version?: string | null
  }) => Promise<{modelId: string; providerConnectionId: string}>
  getProviderConnectionById?: (id: string) => Promise<ProviderConnectionRecord | null>
  getProviderModelsByIds?: (modelIds: string[]) => Promise<Map<string, ProviderModelRecord>>
  listProviderConnections?: () => Promise<ProviderConnectionForAdmin[]>
}

type ProjectTransferDependencyResolutionInput = RuntimePathOptions & {
  deferPlanWrite?: boolean
  layout: ProjectTransferImportTempLayout
  nextPlanRevision: number
  request: ProjectTransferDependencyResolutionRequest
  repositories?: ProjectTransferDependencyResolutionRepositories
}

type ProjectTransferDependencyRevalidationInput = RuntimePathOptions & {
  nextPlanRevision: number
  payloads: Partial<ProjectTransferPayloadByKey>
  plan: ProjectTransferResolvedDependencyPlanArtifact
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
  metadataJson: unknown
  modelName: string
  name: string
  remoteModelId: string | null
  sourceModelId: string
  sourceProviderConnectionId: string
  variant: string | null
  version: string | null
}

type ImportedJudgment = ProjectTransferPayloadRecord & {judgmentInputSignature?: unknown; sourceModelId: string}

type DependencyBlockerInput = {code: string; message: string; scope: string}

const defaultJudgmentModelContext = 32768
const defaultJudgmentPromptTokenLimit = Math.max(0, defaultJudgmentModelContext - MAX_COMPLETION_TOKENS)
const dependencyScopePrefix = 'dependencies.'
const importedSnapshotMarker = 'projectTransferImportedSnapshot'
const dependencyPayloadKeys = [
  'articles',
  'humanJudgmentSummaries',
  'humanJudgments',
  'judgmentAssessments',
  'judgments',
  'models',
  'project',
  'projectPrompts',
  'prompts',
  'providerConnections',
  'reviews',
] as const satisfies readonly (keyof ProjectTransferPayloadByKey)[]

type DependencyPayloadKey = (typeof dependencyPayloadKeys)[number]

const getRepositories = (repositories?: ProjectTransferDependencyResolutionRepositories) => {
  return {
    analyzeTargetRunner:
      repositories === undefined ? getAppDatabaseService() : (repositories.analyzeTargetRunner ?? null),
    ensureCodexProviderModel: repositories?.ensureCodexProviderModel ?? ensureCodexProviderModel,
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

const getBooleanValue = (value: unknown): boolean => {
  return typeof value === 'boolean' ? value : false
}

const normalizeComparableString = (value: unknown): string | null => {
  const normalized = getStringValue(value)

  return normalized === null ? null : normalized.toLocaleLowerCase('en-US')
}

const getConfigRecord = (value: unknown): Record<string, unknown> => {
  const parsed = getJsonValue(value)

  return isRecord(parsed) ? parsed : {}
}

const getImportedSnapshotMarker = (value: unknown) => {
  const record = getConfigRecord(value)
  const marker = record[importedSnapshotMarker]

  return isRecord(marker) ? marker : null
}

const providerHasImportedSnapshotMarker = ({
  sourceProviderConnectionId,
  targetProvider,
}: {
  sourceProviderConnectionId: string
  targetProvider: ProviderConnectionForAdmin | ProviderConnectionRecord
}) => {
  const marker = getImportedSnapshotMarker(targetProvider.config)

  return marker?.sourceProviderConnectionId === sourceProviderConnectionId
}

const modelHasImportedSnapshotMarker = ({
  sourceModelId,
  targetModel,
}: {
  sourceModelId: string
  targetModel: ProviderModelRecord
}) => {
  const marker = getImportedSnapshotMarker(targetModel.metadataJson)

  return marker?.sourceModelId === sourceModelId
}

const importedSnapshotMarkerFingerprintMatches = ({fingerprint, marker}: {fingerprint: unknown; marker: unknown}) => {
  return isRecord(marker) && projectTransferSnapshotFingerprintsEqual(marker.snapshotFingerprint, fingerprint)
}

const getProviderFingerprint = (provider: ImportedProviderConnection | ProviderConnectionForAdmin) => {
  const importedSignature =
    'sourceProviderConnectionId' in provider && isRecord(provider.signature) ? provider.signature : null
  const providerKind = getStringValue(importedSignature?.providerKind) ?? provider.providerKind
  const baseURL =
    'sourceProviderConnectionId' in provider
      ? (getNullableStringValue(importedSignature?.baseURL) ?? provider.baseURL)
      : provider.baseURL

  return getProjectTransferProviderSnapshotFingerprint({
    authMode:
      'sourceProviderConnectionId' in provider ? (importedSignature?.authMode ?? provider.authMode) : provider.authMode,
    baseURL,
    configJson:
      'sourceProviderConnectionId' in provider
        ? (importedSignature?.configSignature ?? provider.configJson)
        : undefined,
    providerKind,
    targetConfig: 'sourceProviderConnectionId' in provider ? undefined : provider.config,
  })
}

const providerFingerprintsMatch = (
  sourceProvider: ImportedProviderConnection,
  targetProvider: ProviderConnectionForAdmin,
) => {
  const marker = getImportedSnapshotMarker(targetProvider.config)
  const sourceFingerprint = getProviderFingerprint(sourceProvider)
  const targetFingerprint = getProviderFingerprint(targetProvider)

  return (
    providerHasImportedSnapshotMarker({
      sourceProviderConnectionId: sourceProvider.sourceProviderConnectionId,
      targetProvider,
    })
    && importedSnapshotMarkerFingerprintMatches({fingerprint: targetFingerprint, marker})
    && projectTransferSnapshotFingerprintsEqual(sourceFingerprint, targetFingerprint)
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

const readExtractedDependencyPayloads = async (
  input: RuntimePathOptions & {layout: ProjectTransferImportTempLayout},
) => {
  const entries = await Promise.all(
    dependencyPayloadKeys.map(async (key) => {
      return [key, await readExtractedPayload({...input, key})] as const
    }),
  )
  const missingPayload = entries.some(([_key, payload]) => {
    return payload === null
  })

  return missingPayload
    ? null
    : entries.reduce<Partial<ProjectTransferPayloadByKey>>((payloads, [key, payload]) => {
        return {...payloads, [key]: payload}
      }, {})
}

const readOperationTablePayload = async ({
  key,
  runner,
  tables,
}: {
  key: DependencyPayloadKey
  runner: ProjectTransferOperationTableRunner
  tables: ProjectTransferOperationTableSet
}) => {
  const rows = await runner.queryJson<{payloadJson: unknown}>(`
    SELECT TO_JSON(payload_json) AS payloadJson
    FROM ${tables.tableNames[key]}
    ORDER BY row_index ASC
  `)
  const values = rows.map((row) => {
    return getJsonValue(row.payloadJson)
  })

  return key === 'project' ? values[0] : values
}

const readDependencyPayloadsFromOperationTables = async ({
  runner,
  tables,
}: {
  runner: ProjectTransferOperationTableRunner
  tables: ProjectTransferOperationTableSet
}) => {
  const entries = await Promise.all(
    dependencyPayloadKeys.map(async (key) => {
      return [key, await readOperationTablePayload({key, runner, tables})] as const
    }),
  )

  return entries.reduce<Partial<ProjectTransferPayloadByKey>>((payloads, [key, payload]) => {
    return payload === undefined ? payloads : {...payloads, [key]: payload}
  }, {})
}

const writeJsonArtifact = async (input: RuntimePathOptions & {pathValue: string; value: unknown}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath(input)
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(input.value))
}

export const writeProjectTransferDependencyPlan = async (
  input: RuntimePathOptions & {layout: ProjectTransferImportTempLayout; plan: ProjectTransferImportPlanArtifact},
) => {
  await writeJsonArtifact({...input, pathValue: input.layout.planPath, value: input.plan})
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
    metadataJson: record.metadataJson ?? null,
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

const getNextAcceptedSubstituteModelSourceIds = (_input: {
  modelSelections: ProjectTransferDependencyModelSelection[]
  previous: ProjectTransferDependencyResolutionState
  unresolvedModelIds: Set<string>
}) => {
  return []
}

const getMaterializedProviderSelections = ({
  _importedModels,
  _request,
}: {
  importedModels: ImportedModel[]
  request: ProjectTransferDependencyResolutionRequest
}) => {
  return []
}

const getNextResolutionState = ({
  importedModels,
  previous,
  request,
}: {
  importedModels: ImportedModel[]
  previous: ProjectTransferDependencyResolutionState
  request: ProjectTransferDependencyResolutionRequest
}): ProjectTransferDependencyResolutionState => {
  const providerSelections = [
    ...getMaterializedProviderSelections({importedModels, request}),
    ...(request.selectedProviderConnections ?? []),
    ...(request.createdProviderConnections ?? []),
  ]
  const modelSelections = [...(request.selectedModels ?? []), ...(request.materializedModels ?? [])]
  const previousUnresolvedProviderIds = request.autoResolve ? [] : previous.unresolvedProviderSourceIds
  const previousUnresolvedModelIds = request.autoResolve ? [] : previous.unresolvedModelSourceIds
  const unresolvedProviderIds = new Set([
    ...previousUnresolvedProviderIds,
    ...(request.unresolvedProviders ?? []).map((entry) => {
      return entry.sourceProviderConnectionId
    }),
  ])
  const unresolvedModelIds = new Set([
    ...previousUnresolvedModelIds,
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
  const acceptedSubstituteModelSourceIds = getNextAcceptedSubstituteModelSourceIds({
    modelSelections,
    previous,
    unresolvedModelIds,
  })

  return {
    acceptedSubstituteModelSourceIds,
    codexSetupState: request.codexSetupState ?? previous.codexSetupState,
    modelMaterializationRequests: [],
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

const getImportedTargetProviderConnectionId = (sourceProviderConnectionId: string) => {
  return `new:provider:${sourceProviderConnectionId}`
}

const getImportedTargetModelId = (sourceModelId: string) => {
  return `new:model:${sourceModelId}`
}

const isImportedTargetProviderConnectionId = (targetProviderConnectionId: string) => {
  return targetProviderConnectionId.startsWith('new:provider:')
}

const isImportedTargetModelId = (targetModelId: string) => {
  return targetModelId.startsWith('new:model:')
}

const getDependencyBlocker = ({code, message, scope}: DependencyBlockerInput): ProjectTransferPlanBlocker => {
  return {code, message, resolutionKind: 'wizard_resolvable', scope}
}

const isDependencyBlocker = (blocker: ProjectTransferPlanBlocker) => {
  return blocker.scope.startsWith(dependencyScopePrefix) || blocker.code.startsWith('dependency_')
}

const getBasePlanBlockers = (plan: ProjectTransferResolvedDependencyPlanArtifact) => {
  return (plan.blockers ?? []).filter((blocker) => {
    return !isDependencyBlocker(blocker) && !isProjectTransferFidelityBlocker(blocker)
  })
}

const getImportedProvidersBySourceId = (providers: ImportedProviderConnection[]) => {
  return providers.reduce<Record<string, ImportedProviderConnection>>((mapped, provider) => {
    return {...mapped, [provider.sourceProviderConnectionId]: provider}
  }, {})
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
    return model.providerConnectionId === connection.id
  })
}

const ensureAutoResolvedCodexDependencies = async ({
  connections,
  autoResolve: _autoResolve,
  explicitMaterializedModelSourceIds: _explicitMaterializedModelSourceIds,
  importedModels: _importedModels,
  importedProvidersBySourceId: _importedProvidersBySourceId,
  repositories: _repositories,
  resolutionState: _resolutionState,
}: {
  autoResolve: boolean
  connections: ProviderConnectionForAdmin[]
  explicitMaterializedModelSourceIds: Set<string>
  importedModels: ImportedModel[]
  importedProvidersBySourceId: Record<string, ImportedProviderConnection>
  repositories: ReturnType<typeof getRepositories>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  return connections
}

const modelVariantMatches = (source: ImportedModel, target: ProviderModelRecord) => {
  return (
    normalizeProjectTransferModelVariant(source.variant) === normalizeProjectTransferModelVariant(target.variant)
    && normalizeProjectTransferModelVariant(source.version) === normalizeProjectTransferModelVariant(target.version)
  )
}

const remoteModelMatches = (source: ImportedModel, target: ProviderModelRecord) => {
  return (
    modelHasImportedSnapshotMarker({sourceModelId: source.sourceModelId, targetModel: target})
    && source.remoteModelId !== null
    && normalizeComparableString(target.remoteModelId) === normalizeComparableString(source.remoteModelId)
    && modelVariantMatches(source, target)
  )
}

const nullableRemoteModelMatches = (source: ImportedModel, target: ProviderModelRecord) => {
  return (
    modelHasImportedSnapshotMarker({sourceModelId: source.sourceModelId, targetModel: target})
    && source.remoteModelId === null
    && normalizeComparableString(target.remoteModelId) === null
    && normalizeComparableString(target.modelName) === normalizeComparableString(source.modelName)
    && normalizeComparableString(target.name) === normalizeComparableString(source.name)
    && normalizeComparableString(target.displayName) === normalizeComparableString(source.displayName)
    && modelVariantMatches(source, target)
  )
}

const getSourceModelFingerprint = ({
  sourceModel,
  sourceProvider,
}: {
  sourceModel: ImportedModel
  sourceProvider: ImportedProviderConnection
}) => {
  const importedSignature = isRecord(sourceProvider.signature) ? sourceProvider.signature : null
  const providerKind = getStringValue(importedSignature?.providerKind) ?? sourceProvider.providerKind
  const baseURL = getNullableStringValue(importedSignature?.baseURL) ?? sourceProvider.baseURL

  return getProjectTransferModelSnapshotFingerprint({
    displayName: sourceModel.displayName,
    metadataJson: sourceModel.metadataJson,
    modelName: sourceModel.modelName,
    name: sourceModel.name,
    provider: {
      authMode: importedSignature?.authMode ?? sourceProvider.authMode,
      baseURL,
      configJson: importedSignature?.configSignature ?? sourceProvider.configJson,
      providerKind,
    },
    remoteModelId: sourceModel.remoteModelId,
    variant: sourceModel.variant,
    version: sourceModel.version,
  })
}

const getTargetModelFingerprint = ({
  targetModel,
  targetProvider,
}: {
  targetModel: ProviderModelRecord
  targetProvider: ProviderConnectionForAdmin
}) => {
  return getProjectTransferModelSnapshotFingerprint({
    displayName: targetModel.displayName,
    metadataJson: targetModel.metadataJson,
    modelName: targetModel.modelName,
    name: targetModel.name,
    provider: {
      authMode: targetProvider.authMode,
      baseURL: targetProvider.baseURL,
      providerKind: targetProvider.providerKind,
      targetConfig: targetProvider.config,
    },
    remoteModelId: targetModel.remoteModelId,
    variant: targetModel.variant,
    version: targetModel.version,
  })
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
  sourceProvider,
  sourceModel,
  targetProvider,
  targetModel,
}: {
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  sourceProvider: ImportedProviderConnection
  sourceModel: ImportedModel
  targetProvider: ProviderConnectionForAdmin
  targetModel: ProviderModelRecord
}) => {
  const targetFingerprint = getTargetModelFingerprint({targetModel, targetProvider})
  const marker = getImportedSnapshotMarker(targetModel.metadataJson)

  return (
    (remoteModelMatches(sourceModel, targetModel) || nullableRemoteModelMatches(sourceModel, targetModel))
    && importedSnapshotMarkerFingerprintMatches({fingerprint: targetFingerprint, marker})
    && projectTransferSnapshotFingerprintsEqual(
      getSourceModelFingerprint({sourceModel, sourceProvider}),
      targetFingerprint,
    )
    && targetModelRequestMatches(judgmentModelSignaturesBySourceId[sourceModel.sourceModelId] ?? [], targetModel)
  )
}

const getUniqueEquivalentTargetModel = ({
  connection,
  judgmentModelSignaturesBySourceId,
  sourceProvider,
  sourceModel,
}: {
  connection: ProviderConnectionForAdmin
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  sourceProvider: ImportedProviderConnection
  sourceModel: ImportedModel
}) => {
  const candidates = getSourceModelIdentityCandidates(sourceModel, connection).filter((targetModel) => {
    return targetModelEquivalentForImportedJudgments({
      judgmentModelSignaturesBySourceId,
      sourceModel,
      sourceProvider,
      targetModel,
      targetProvider: connection,
    })
  })

  return candidates.length === 1 ? candidates[0] : null
}

const getConnectionById = (connections: ProviderConnectionForAdmin[]) => {
  return connections.reduce<Record<string, ProviderConnectionForAdmin>>((mapped, connection) => {
    return {...mapped, [connection.id]: connection}
  }, {})
}

const getUniqueEquivalentTargetProviderConnection = ({
  connections,
  importedProvider,
}: {
  connections: ProviderConnectionForAdmin[]
  importedProvider: ImportedProviderConnection
}) => {
  const candidates = connections.filter((connection) => {
    return providerFingerprintsMatch(importedProvider, connection)
  })

  return candidates.length === 1 ? candidates[0] : null
}

const validateExplicitProviderSelections = async ({
  connectionById: _connectionById,
  getProviderConnectionById: _getProviderConnectionById,
  resolutionState: _resolutionState,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  getProviderConnectionById: (id: string) => Promise<ProviderConnectionRecord | null>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  return null
}

const validateExplicitModelSelections = async ({
  getProviderModelsByIds: _getProviderModelsByIds,
  resolutionState: _resolutionState,
}: {
  getProviderModelsByIds: (modelIds: string[]) => Promise<Map<string, ProviderModelRecord>>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  return null
}

const getResolvedProviderMappings = ({
  autoResolve,
  connections,
  importedProviders,
  resolutionState,
}: {
  autoResolve: boolean
  connections: ProviderConnectionForAdmin[]
  importedProviders: ImportedProviderConnection[]
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  const connectionById = getConnectionById(connections)

  return importedProviders.reduce<Record<string, string>>((mapped, importedProvider) => {
    const sourceProviderConnectionId = importedProvider.sourceProviderConnectionId
    const existingTargetId = resolutionState.providerTargetBySourceId[sourceProviderConnectionId]
    const existingTargetProviderConnection = existingTargetId ? (connectionById[existingTargetId] ?? null) : null
    const reusableExistingTargetId =
      existingTargetId && isImportedTargetProviderConnectionId(existingTargetId)
        ? existingTargetId
        : existingTargetProviderConnection !== null
            && providerFingerprintsMatch(importedProvider, existingTargetProviderConnection)
          ? existingTargetId
          : null
    const equivalentTargetProviderConnection = getUniqueEquivalentTargetProviderConnection({
      connections,
      importedProvider,
    })
    const targetProviderConnectionId = resolutionState.unresolvedProviderSourceIds.includes(sourceProviderConnectionId)
      ? null
      : reusableExistingTargetId
        ? reusableExistingTargetId
        : !autoResolve
          ? null
          : (equivalentTargetProviderConnection?.id
            ?? getImportedTargetProviderConnectionId(sourceProviderConnectionId))

    return targetProviderConnectionId ? {...mapped, [sourceProviderConnectionId]: targetProviderConnectionId} : mapped
  }, {})
}

const getResolvedModelMappings = ({
  connectionById,
  importedModels,
  importedProvidersBySourceId,
  judgmentModelSignaturesBySourceId,
  providerTargetBySourceId,
  resolutionState,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  importedModels: ImportedModel[]
  importedProvidersBySourceId: Record<string, ImportedProviderConnection>
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  providerTargetBySourceId: Record<string, string>
  resolutionState: ProjectTransferDependencyResolutionState
}) => {
  const targetModelById = getTargetModelById(Object.values(connectionById))

  return importedModels.reduce<Record<string, string>>((mapped, importedModel) => {
    const sourceModelId = importedModel.sourceModelId
    const existingTargetId = resolutionState.modelTargetBySourceId[sourceModelId]
    const existingTargetModel = existingTargetId ? (targetModelById[existingTargetId] ?? null) : null
    const targetProviderConnectionId = providerTargetBySourceId[importedModel.sourceProviderConnectionId]
    const connection = targetProviderConnectionId ? (connectionById[targetProviderConnectionId] ?? null) : null
    const importedProvider = importedProvidersBySourceId[importedModel.sourceProviderConnectionId] ?? null
    const existingTargetProvider = existingTargetModel?.providerConnectionId
      ? (connectionById[existingTargetModel.providerConnectionId] ?? null)
      : null
    const reusableExistingTargetId =
      existingTargetId && isImportedTargetModelId(existingTargetId)
        ? existingTargetId
        : existingTargetModel !== null
            && existingTargetProvider !== null
            && importedProvider !== null
            && targetProviderConnectionId === existingTargetModel.providerConnectionId
            && targetModelEquivalentForImportedJudgments({
              judgmentModelSignaturesBySourceId,
              sourceModel: importedModel,
              sourceProvider: importedProvider,
              targetModel: existingTargetModel,
              targetProvider: existingTargetProvider,
            })
          ? existingTargetId
          : null
    const targetModelId = resolutionState.unresolvedModelSourceIds.includes(sourceModelId)
      ? null
      : reusableExistingTargetId
        ? reusableExistingTargetId
        : !targetProviderConnectionId
          ? null
          : isImportedTargetProviderConnectionId(targetProviderConnectionId)
            ? getImportedTargetModelId(sourceModelId)
            : connection === null
              ? null
              : importedProvider === null
                ? getImportedTargetModelId(sourceModelId)
                : (getUniqueEquivalentTargetModel({
                    connection,
                    judgmentModelSignaturesBySourceId,
                    sourceModel: importedModel,
                    sourceProvider: importedProvider,
                  })?.id ?? getImportedTargetModelId(sourceModelId))

    return targetModelId ? {...mapped, [sourceModelId]: targetModelId} : mapped
  }, {})
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
      const importedTarget =
        targetProviderConnectionId !== undefined && isImportedTargetProviderConnectionId(targetProviderConnectionId)
      const targetConnection = targetProviderConnectionId ? (connectionById[targetProviderConnectionId] ?? null) : null
      const equivalentConnection = targetConnection
        ? providerFingerprintsMatch(importedProvider, targetConnection)
        : false
      const status: ProjectTransferDependencyStatus = importedTarget
        ? 'resolved'
        : targetConnection && equivalentConnection
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
  importedModel,
  importedProvider,
  judgmentModelSignaturesBySourceId,
  providerTargetBySourceId,
  targetModelId,
  targetModel,
  targetProvider,
}: {
  importedModel: ImportedModel
  importedProvider: ImportedProviderConnection | null
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  providerTargetBySourceId: Record<string, string>
  targetModelId: string | null
  targetModel: ProviderModelRecord | null
  targetProvider: ProviderConnectionForAdmin | null
}): ProjectTransferDependencyStatus => {
  if (targetModelId !== null && isImportedTargetModelId(targetModelId)) {
    return providerTargetBySourceId[importedModel.sourceProviderConnectionId] ? 'resolved' : 'missing'
  }

  if (!targetModel || !targetModel.providerConnectionId || importedProvider === null) {
    return 'missing'
  }

  if (
    providerTargetBySourceId[importedModel.sourceProviderConnectionId] !== targetModel.providerConnectionId
    || targetProvider === null
  ) {
    return 'blocked'
  }

  if (
    targetModelEquivalentForImportedJudgments({
      judgmentModelSignaturesBySourceId,
      sourceModel: importedModel,
      sourceProvider: importedProvider,
      targetModel,
      targetProvider,
    })
  ) {
    return 'resolved'
  }

  return 'blocked'
}

const getModelStatusesAndBlockers = ({
  connectionById,
  importedModels,
  importedProvidersBySourceId,
  judgmentModelSignaturesBySourceId,
  modelTargetBySourceId,
  providerTargetBySourceId,
  targetModelById,
}: {
  connectionById: Record<string, ProviderConnectionForAdmin>
  importedModels: ImportedModel[]
  importedProvidersBySourceId: Record<string, ImportedProviderConnection>
  judgmentModelSignaturesBySourceId: Record<string, unknown[]>
  modelTargetBySourceId: Record<string, string>
  providerTargetBySourceId: Record<string, string>
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
      const importedProvider = importedProvidersBySourceId[importedModel.sourceProviderConnectionId] ?? null
      const targetProvider = targetModel?.providerConnectionId
        ? (connectionById[targetModel.providerConnectionId] ?? null)
        : null
      const status = getModelStatus({
        importedModel,
        importedProvider,
        judgmentModelSignaturesBySourceId,
        providerTargetBySourceId,
        targetModelId: targetModelId ?? null,
        targetModel,
        targetProvider,
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

const getReadyDependencyStatuses = (dependencyStatuses: Record<string, ProjectTransferDependencyStatus>) => {
  return Object.values(dependencyStatuses).every((status) => {
    return status === 'resolved' || status === 'not_required'
  })
}

const getCanCommit = (summary: ProjectTransferPlanSummary) => {
  return (
    summary.blockerCount === 0
    && getReadyDependencyStatuses(summary.dependencyStatuses)
    && (summary.judgmentConflictStatus ?? 'clear') === 'clear'
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
    targetPlan: previousPlan.targetPlan,
  }
  const nextComparable = {
    blockers: nextPlan.blockers,
    canCommit: nextPlan.canCommit,
    dependencyResolution: nextPlan.dependencyResolution ?? null,
    summary: nextPlan.summary,
    targetPlan: nextPlan.targetPlan,
  }

  return getProjectTransferCanonicalJson(previousComparable) !== getProjectTransferCanonicalJson(nextComparable)
}

const getResolvedPlan = ({
  dependencyResolution,
  dependencySummary,
  fidelityTargetPlan,
  nextPlanRevision,
  previousPlan,
}: {
  dependencyResolution: ProjectTransferDependencyResolutionState
  dependencySummary: ProjectTransferPlanSummary
  fidelityTargetPlan?: Partial<ProjectTransferResolvedDependencyPlanArtifact['targetPlan']>
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
    targetPlan: {...previousPlan.targetPlan, ...(fidelityTargetPlan ?? {})},
  }
}

export const revalidateProjectTransferResolvedDependencies = async (
  input: ProjectTransferDependencyRevalidationInput,
): Promise<ProjectTransferDependencyResolutionResult> => {
  if (input.request.planRevision !== input.plan.planRevision) {
    return {error: 'Project transfer dependency request planRevision is stale', status: 'error', statusCode: 409}
  }

  const repositories = getRepositories(input.repositories)
  const initialConnections = await repositories.listProviderConnections()
  const previousResolutionState = getPlanDependencyResolution(input.plan)
  const importedModels = (input.payloads.models ?? []).map(getImportedModel)
  const importedProviders = (input.payloads.providerConnections ?? []).map(getImportedProviderConnection)
  const importedJudgments = (input.payloads.judgments ?? []).map(getImportedJudgment)
  const importedProvidersBySourceId = getImportedProvidersBySourceId(importedProviders)
  const judgmentModelSignaturesBySourceId = getJudgmentModelSignaturesBySourceId(importedJudgments)
  const requestedResolutionState = getNextResolutionState({
    importedModels,
    previous: previousResolutionState,
    request: input.request,
  })
  const connections = await ensureAutoResolvedCodexDependencies({
    autoResolve: input.request.autoResolve !== false,
    connections: initialConnections,
    explicitMaterializedModelSourceIds: new Set(
      (input.request.materializedModels ?? []).map((entry) => {
        return entry.sourceModelId
      }),
    ),
    importedModels,
    importedProvidersBySourceId,
    repositories,
    resolutionState: requestedResolutionState,
  })
  const connectionById = getConnectionById(connections)
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

  const providerTargetBySourceId = getResolvedProviderMappings({
    autoResolve: input.request.autoResolve !== false,
    connections,
    importedProviders,
    resolutionState: requestedResolutionState,
  })
  const modelTargetBySourceId = getResolvedModelMappings({
    connectionById,
    importedModels,
    importedProvidersBySourceId,
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
    connectionById,
    importedModels,
    importedProvidersBySourceId,
    judgmentModelSignaturesBySourceId,
    modelTargetBySourceId,
    providerTargetBySourceId,
    targetModelById: getTargetModelById(connections),
  })
  const dependencyPlanSummary = getResolvedPlanSummary({
    dependencyBlockers: [...providerResolution.blockers, ...modelResolution.blockers],
    dependencyStatuses: {...providerResolution.statuses, ...modelResolution.statuses},
    plan: input.plan,
  })
  const fidelityValidation = await getProjectTransferFidelityValidation({
    dependencyResolution,
    payloads: input.payloads,
    runner: repositories.analyzeTargetRunner,
    targetConnections: connections,
    targetPlan: input.plan.targetPlan,
  })
  const fidelityBlockers = getReadyDependencyStatuses(dependencyPlanSummary.dependencyStatuses)
    ? fidelityValidation.blockers
    : []
  const planSummary = {
    ...dependencyPlanSummary,
    blockerCount: (dependencyPlanSummary.blockers ?? []).length + fidelityBlockers.length,
    blockers: [...(dependencyPlanSummary.blockers ?? []), ...fidelityBlockers],
    conflictCounts: {...dependencyPlanSummary.conflictCounts, ...fidelityValidation.conflictCounts},
    judgmentConflictStatus: getReadyDependencyStatuses(dependencyPlanSummary.dependencyStatuses)
      ? fidelityValidation.judgmentConflictStatus
      : 'unknown',
    overlapCounts: {...dependencyPlanSummary.overlapCounts, ...fidelityValidation.overlapCounts},
  } satisfies ProjectTransferPlanSummary
  const nextPlan = getResolvedPlan({
    dependencyResolution,
    dependencySummary: planSummary,
    fidelityTargetPlan: fidelityValidation.targetPlan,
    nextPlanRevision: input.nextPlanRevision,
    previousPlan: input.plan,
  })
  const changed = getResultChanged({nextPlan, previousPlan: input.plan})
  const finalPlan = changed ? nextPlan : input.plan

  return {changed, plan: finalPlan, planSummary: finalPlan.summary, status: 'ok'}
}

export const resolveProjectTransferDependencies = async (
  input: ProjectTransferDependencyResolutionInput,
): Promise<ProjectTransferDependencyResolutionResult> => {
  const plan = await readJsonArtifact<ProjectTransferResolvedDependencyPlanArtifact>({
    ...input,
    pathValue: input.layout.planPath,
  })

  if (plan === null) {
    return {error: 'Project transfer import plan artifact is unavailable', status: 'error', statusCode: 409}
  }

  if (input.request.planRevision !== plan.planRevision) {
    return {error: 'Project transfer dependency request planRevision is stale', status: 'error', statusCode: 409}
  }

  const runRevalidation = (
    payloads: Partial<ProjectTransferPayloadByKey>,
    analyzeTargetRunner?: ProjectTransferAnalyzeTargetRunner,
  ) => {
    const repositories =
      analyzeTargetRunner === undefined
        ? input.repositories
        : ({...input.repositories, analyzeTargetRunner} satisfies ProjectTransferDependencyResolutionRepositories)

    return revalidateProjectTransferResolvedDependencies({
      nextPlanRevision: input.nextPlanRevision,
      payloads,
      plan,
      repositories,
      request: input.request,
    })
  }
  const result =
    input.repositories === undefined
      ? await withProjectTransferOperationTables({
          cwd: input.cwd,
          envValues: input.envValues,
          layout: input.layout,
          operationId: `dependency_${input.request.planRevision}_${input.nextPlanRevision}`,
          work: async ({runner, tables}) => {
            const payloads = await readDependencyPayloadsFromOperationTables({runner, tables})

            return runRevalidation(payloads, runner)
          },
        })
      : await readExtractedDependencyPayloads(input).then((payloads) => {
          return payloads === null
            ? ({
                error: 'Project transfer dependency payloads are unavailable',
                status: 'error',
                statusCode: 409,
              } as const)
            : runRevalidation(payloads)
        })

  if (result.status === 'ok' && result.changed && input.deferPlanWrite !== true) {
    await writeProjectTransferDependencyPlan({...input, plan: result.plan})
  }

  return result
}

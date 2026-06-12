import {randomUUID} from 'node:crypto'
import {mkdir, rm} from 'node:fs/promises'
import {dirname} from 'node:path'

import type {ProjectTransferHistoryRecord, ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import {writeRuntimeLogEvent} from '../../utils/runtimeLogger.ts'
import type {
  ProjectTransferImportAnalysisArtifact,
  ProjectTransferImportPlanArtifact,
} from './projectTransferAnalyze.ts'
import {
  getProjectTransferAnalyzeTargetPlan,
  type ProjectTransferAnalyzeTargetRunner,
  type ProjectTransferTargetPlan,
} from './projectTransferAnalyzeTarget.ts'
import {
  promoteProjectTransferCommitAssets,
  rollbackProjectTransferCommitPromotion,
} from './projectTransferCommitRollback.ts'
import {
  type ProjectTransferCommitAppWriteResult,
  writeProjectTransferCommitAppTables,
} from './projectTransferCommitWriter.ts'
import {
  getProjectTransferCommitExecutionMode,
  parseProjectTransferCompletionPayload,
  parseProjectTransferPlanSummary,
  parseProjectTransferProgressPayload,
  type ProjectTransferCompletionPayload,
  type ProjectTransferExecutionMode,
  type ProjectTransferImportCompletionPayload,
  type ProjectTransferPlanBlocker,
  type ProjectTransferPlanSummary,
  type ProjectTransferProgressPayload,
  type ProjectTransferRuntimeEvent,
  toProjectTransferSessionResponse,
  validateProjectTransferPlanReadyToCommit,
} from './projectTransferContracts.ts'
import {
  type ProjectTransferDependencyResolutionRepositories,
  type ProjectTransferDependencyResolutionRequest,
  type ProjectTransferDependencyResolutionState,
  revalidateProjectTransferResolvedDependencies,
} from './projectTransferDependencyResolution.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {getProjectTransferHistoryRepository} from './projectTransferHistoryRepository.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {
  parseProjectTransferPayload,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
} from './projectTransferPayloadSchemas.ts'
import {
  getProjectTransferPerformanceMetrics,
  getProjectTransferPerformanceRowCounters,
  getProjectTransferPerformanceRowCountersFromPayloads,
  measureProjectTransferPhase,
  mergeProjectTransferPerformanceMetrics,
  projectTransferMetricUnavailable,
  type ProjectTransferPerformanceMetrics,
} from './projectTransferPerformanceMetrics.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout, type ProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferSessionRepository} from './projectTransferSessionRepository.ts'
import {
  getProjectTransferCurrentImportStagingLayout,
  getProjectTransferProgressStagingRevision,
  validateProjectTransferReviewedPlanStagingRevision,
} from './projectTransferStaging.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type ProjectTransferCommitRequest = {expectedPlanRevision?: number; planRevision?: number}

type ProjectTransferCommitRepositories = {
  analyzeTargetRunner?: ProjectTransferAnalyzeTargetRunner | null
  dependencyRepositories?: ProjectTransferDependencyResolutionRepositories
  getCommitId?: () => string
  getOwnerToken?: () => string
  historyRepository?: Pick<
    ReturnType<typeof getProjectTransferHistoryRepository>,
    'getCompletedImportHistoryBySessionId'
  >
  revalidate?: (input: ProjectTransferCommitRevalidationInput) => Promise<ProjectTransferCommitRevalidationResult>
  runAppTableWrites?: (input: ProjectTransferCommitAppTableWriteInput) => Promise<ProjectTransferCommitAppWriteResult>
  startBackgroundCommit?: (operation: () => Promise<void>) => void
  sessionRepository?: Pick<
    ReturnType<typeof getProjectTransferSessionRepository>,
    | 'getProjectTransferSession'
    | 'markProjectTransferSessionTerminalCleanupComplete'
    | 'persistProjectTransferSessionCompletion'
    | 'reopenProjectTransferCommitSession'
    | 'transitionProjectTransferSessionState'
    | 'updateProjectTransferSessionPlanRevision'
  >
}

export type ProjectTransferCommitInput = RuntimePathOptions & {
  now?: Date
  repositories?: ProjectTransferCommitRepositories
  request: ProjectTransferCommitRequest
  sessionId: string
}

type ProjectTransferCommitArtifacts = {
  analysis: ProjectTransferImportAnalysisArtifact
  layout: ProjectTransferImportTempLayout
  plan: ProjectTransferImportPlanArtifact
}

type ProjectTransferCommitRevalidationInput = RuntimePathOptions & {
  analysis: ProjectTransferImportAnalysisArtifact
  layout: ProjectTransferImportTempLayout
  nextPlanRevision: number
  plan: ProjectTransferImportPlanArtifact
  repositories?: Pick<ProjectTransferCommitRepositories, 'analyzeTargetRunner' | 'dependencyRepositories'>
}

type ProjectTransferCommitRevalidationResult = {
  changed: boolean
  performanceMetrics?: ProjectTransferPerformanceMetrics
  plan: ProjectTransferImportPlanArtifact
  ready: boolean
}

type ProjectTransferCommitResolvedDependencyPlanArtifact = ProjectTransferImportPlanArtifact & {
  dependencyResolution?: ProjectTransferDependencyResolutionState
}

type ProjectTransferCommitAppTableWriteInput = RuntimePathOptions & {
  artifacts: ProjectTransferCommitArtifacts
  commitId: string
  now: Date
  schemaVersion: number
  sessionId: string
}

export type ProjectTransferCommitResult =
  | {error: string; status: 'error'; statusCode: number}
  | {
      completion: ProjectTransferCompletionPayload
      history: ProjectTransferHistoryRecord | null
      session: ProjectTransferSessionRecord
      status: 'completed'
      statusCode: 200
    }
  | {session: ProjectTransferSessionRecord; status: 'in_flight'; statusCode: 202}
  | {
      commitId: string
      executionMode: 'background'
      session: ProjectTransferSessionRecord
      status: 'claimed'
      statusCode: 202
    }
  | {plan: ProjectTransferImportPlanArtifact; session: ProjectTransferSessionRecord; status: 'stale'; statusCode: 200}

const revalidatedTargetPlanKeys = [
  'articleMatches',
  'articleRoutePlan',
  'articleUpdatePlan',
  'assetPromotionPlan',
  'duplicateImportMatches',
  'projectPromptPlan',
  'projectRoutePlan',
  'promptPlan',
] as const satisfies readonly (keyof ProjectTransferTargetPlan)[]
const commitWorkerHeartbeatIntervalMs = 15_000

const getCommitError = (message: string): never => {
  throw new Error(`Project transfer commit: ${message}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const assertRecord = (value: unknown, label: string): Record<string, unknown> => {
  return isRecord(value) ? value : getCommitError(`${label} must be an object`)
}

const assertArray = (value: unknown, label: string): unknown[] => {
  return Array.isArray(value) ? value : getCommitError(`${label} must be an array`)
}

const assertNonNegativeInteger = (value: unknown, label: string): number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : getCommitError(`${label} must be a non-negative integer`)
}

const assertNullableString = (value: unknown, label: string): string | null => {
  return value === null || typeof value === 'string' ? value : getCommitError(`${label} must be a string or null`)
}

const assertPlanSummary = (value: unknown, label: string): ProjectTransferPlanSummary => {
  const summary = parseProjectTransferPlanSummary(value)

  return summary === null ? getCommitError(`${label} must be a plan summary`) : summary
}

const assertAnalysisArtifact = (value: unknown): ProjectTransferImportAnalysisArtifact => {
  const analysis = assertRecord(value, 'analysis.json')
  assertNonNegativeInteger(analysis.planRevision, 'analysis.planRevision')
  assertNullableString(analysis.packageFingerprint, 'analysis.packageFingerprint')
  assertRecord(analysis.archive, 'analysis.archive')
  assertRecord(analysis.assetSummary, 'analysis.assetSummary')
  assertRecord(analysis.packageCounts, 'analysis.packageCounts')
  assertRecord(analysis.payloads, 'analysis.payloads')
  assertRecord(analysis.manifest, 'analysis.manifest')

  return analysis as ProjectTransferImportAnalysisArtifact
}

const getAnalysisSchemaVersion = (analysis: ProjectTransferImportAnalysisArtifact) => {
  const schemaVersion = analysis.manifest.schemaVersion

  return typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion > 0
    ? schemaVersion
    : getCommitError('analysis manifest schemaVersion must be a positive integer')
}

const assertTargetPlanArtifact = (value: unknown): ProjectTransferTargetPlan => {
  const targetPlan = assertRecord(value, 'plan.targetPlan')
  assertArray(targetPlan.articleMatches, 'plan.targetPlan.articleMatches')
  assertArray(targetPlan.articleRoutePlan, 'plan.targetPlan.articleRoutePlan')
  assertArray(targetPlan.articleUpdatePlan, 'plan.targetPlan.articleUpdatePlan')
  assertArray(targetPlan.assetPromotionPlan, 'plan.targetPlan.assetPromotionPlan')
  assertArray(targetPlan.duplicateImportMatches, 'plan.targetPlan.duplicateImportMatches')
  assertArray(targetPlan.projectPromptPlan, 'plan.targetPlan.projectPromptPlan')
  assertArray(targetPlan.projectRoutePlan, 'plan.targetPlan.projectRoutePlan')
  assertArray(targetPlan.promptPlan, 'plan.targetPlan.promptPlan')

  return targetPlan as ProjectTransferTargetPlan
}

const assertPlanArtifact = (value: unknown): ProjectTransferImportPlanArtifact => {
  const plan = assertRecord(value, 'plan.json')
  const summary = assertPlanSummary(plan.summary, 'plan.summary')
  const targetPlan = assertTargetPlanArtifact(plan.targetPlan)
  assertArray(plan.blockers, 'plan.blockers')
  assertRecord(plan.packageCounts, 'plan.packageCounts')
  assertNullableString(plan.packageFingerprint, 'plan.packageFingerprint')
  assertArray(plan.packageWarnings, 'plan.packageWarnings')
  assertNonNegativeInteger(plan.planRevision, 'plan.planRevision')
  assertRecord(plan.resolutionKinds, 'plan.resolutionKinds')

  return {...plan, summary, targetPlan} as ProjectTransferImportPlanArtifact
}

const readJsonArtifact = async <TValue>(input: RuntimePathOptions & {pathValue: string}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath(input)
  const file = globalThis.Bun.file(resolvedPath)

  return (await file.exists())
    ? (JSON.parse(await file.text()) as TValue)
    : getCommitError(`missing ${input.pathValue}`)
}

export const loadProjectTransferCommitArtifacts = async ({
  session,
  sessionId,
  ...runtimeOptions
}: RuntimePathOptions & {
  session?: ProjectTransferSessionRecord
  sessionId: string
}): Promise<ProjectTransferCommitArtifacts> => {
  const baseLayout = getProjectTransferImportTempLayout(sessionId)
  const layout =
    session === undefined
      ? baseLayout
      : getProjectTransferCurrentImportStagingLayout({
          layout: baseLayout,
          progress: parseProjectTransferProgressPayload(session.progressJson),
        })
  const [analysis, plan] = await Promise.all([
    readJsonArtifact({...runtimeOptions, pathValue: layout.analysisPath}),
    readJsonArtifact({...runtimeOptions, pathValue: layout.planPath}),
  ])

  return {analysis: assertAnalysisArtifact(analysis), layout, plan: assertPlanArtifact(plan)}
}

const writePlanArtifact = async ({
  layout,
  plan,
  runtimeOptions,
}: {
  layout: ProjectTransferImportTempLayout
  plan: ProjectTransferImportPlanArtifact
  runtimeOptions: RuntimePathOptions
}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.planPath})
  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(plan))
}

const writeCompletionArtifact = async ({
  completion,
  layout,
  runtimeOptions,
}: {
  completion: ProjectTransferImportCompletionPayload
  layout: ProjectTransferImportTempLayout
  runtimeOptions: RuntimePathOptions
}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.completionPath})
  await mkdir(dirname(resolvedPath), {recursive: true})
  await globalThis.Bun.write(resolvedPath, getProjectTransferCanonicalJson(completion))
}

const cleanupCompletedImportArtifacts = async ({
  layout,
  repositories,
  runtimeOptions,
  sessionId,
}: {
  layout: ProjectTransferImportTempLayout
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
  sessionId: string
}) => {
  const rootPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.rootPath})

  await rm(rootPath, {force: true, recursive: true})
  await repositories.sessionRepository.markProjectTransferSessionTerminalCleanupComplete({
    expectedOwnerToken: null,
    expectedState: 'completed',
    sessionId,
  })
}

const getPayloadPath = (layout: ProjectTransferImportTempLayout, key: keyof ProjectTransferPayloadByKey) => {
  return `${layout.extractedPath}/${projectTransferPayloadPathByKey[key]}`
}

const readTextArtifact = async (input: RuntimePathOptions & {pathValue: string}) => {
  const resolvedPath = resolveProjectTransferTempWritablePath(input)
  const file = globalThis.Bun.file(resolvedPath)

  return (await file.exists()) ? file.text() : getCommitError(`missing ${input.pathValue}`)
}

const readExtractedPayload = async <TKey extends keyof ProjectTransferPayloadByKey>(
  input: RuntimePathOptions & {key: TKey; layout: ProjectTransferImportTempLayout},
) => {
  const text = await readTextArtifact({...input, pathValue: getPayloadPath(input.layout, input.key)})

  return parseProjectTransferPayload(input.key, text)
}

const readExtractedPayloads = async (input: RuntimePathOptions & {layout: ProjectTransferImportTempLayout}) => {
  const entries = await Promise.all(
    projectTransferPayloadKeys.map(async (key) => {
      return [key, await readExtractedPayload({...input, key})] as const
    }),
  )

  return entries.reduce<Partial<ProjectTransferPayloadByKey>>((payloads, [key, payload]) => {
    return {...payloads, [key]: payload as ProjectTransferPayload}
  }, {})
}

const getPackageCount = (plan: ProjectTransferImportPlanArtifact, key: string) => {
  const value = plan.packageCounts[key as keyof typeof plan.packageCounts]

  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

const getExtractedAssetBytes = (analysis: ProjectTransferImportAnalysisArtifact) => {
  const value = analysis.assetSummary.actualByteLength

  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

const getCommitRowCount = (plan: ProjectTransferImportPlanArtifact) => {
  return Object.values(plan.packageCounts).reduce((total, count) => {
    return total + (typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0)
  }, 0)
}

const getImportPerformanceMetrics = (performanceMetrics: ProjectTransferPerformanceMetrics | null | undefined) => {
  return performanceMetrics ?? getProjectTransferPerformanceMetrics({operation: 'import'})
}

const getCommitPerformanceMetrics = ({
  artifacts,
  baseMetrics,
  payloads,
  writeMetrics,
}: {
  artifacts: ProjectTransferCommitArtifacts
  baseMetrics?: ProjectTransferPerformanceMetrics | null
  payloads?: Partial<ProjectTransferPayloadByKey>
  writeMetrics?: ProjectTransferPerformanceMetrics | null
}) => {
  const payloadRows =
    payloads === undefined
      ? getProjectTransferPerformanceRowCounters({
          assetEntryCount: artifacts.analysis.assetSummary.actualEntryCount,
          assetReferenceCount: projectTransferMetricUnavailable,
          payloadCounts: artifacts.plan.packageCounts,
        })
      : getProjectTransferPerformanceRowCountersFromPayloads(payloads)
  const commitMetrics = getProjectTransferPerformanceMetrics({
    benchmark: {
      conflictShape: artifacts.plan.summary.conflictCounts,
      finalAssetBytes: artifacts.analysis.assetSummary.actualByteLength,
      packageFingerprint: artifacts.analysis.packageFingerprint ?? undefined,
      schemaVersion: artifacts.analysis.manifest.schemaVersion,
    },
    bytes: {
      assetBytes: artifacts.analysis.assetSummary.actualByteLength,
      expandedArchiveBytes: artifacts.analysis.archive.expandedBytes,
      packageBytes: artifacts.analysis.archive.packageSizeBytes,
    },
    operation: 'import',
    rows: payloadRows,
    warnings: artifacts.plan.summary.packageWarnings ?? [],
  })
  const withBase = mergeProjectTransferPerformanceMetrics(
    getImportPerformanceMetrics(baseMetrics ?? artifacts.analysis.performanceMetrics),
    commitMetrics,
  )

  return writeMetrics === null || writeMetrics === undefined
    ? withBase
    : mergeProjectTransferPerformanceMetrics(withBase, writeMetrics)
}

const getCommitExecutionMode = (artifacts: ProjectTransferCommitArtifacts): ProjectTransferExecutionMode => {
  return getProjectTransferCommitExecutionMode({
    articleCount: getPackageCount(artifacts.plan, 'articles'),
    extractedAssetBytes: getExtractedAssetBytes(artifacts.analysis),
    judgmentCount: getPackageCount(artifacts.plan, 'judgments'),
  })
}

const getReviewedPlanRevision = (
  request: ProjectTransferCommitRequest,
): {error: string; ok: false} | {ok: true; planRevision: number} => {
  const planRevision = request.planRevision ?? null
  const expectedPlanRevision = request.expectedPlanRevision ?? null

  if (planRevision === null && expectedPlanRevision === null) {
    return {error: 'Project transfer commit requires planRevision', ok: false}
  }

  if (planRevision !== null && expectedPlanRevision !== null && planRevision !== expectedPlanRevision) {
    return {error: 'Project transfer commit planRevision and expectedPlanRevision conflict', ok: false}
  }

  if (planRevision !== null && expectedPlanRevision !== null) {
    return {error: 'Project transfer commit requires exactly one reviewed plan revision', ok: false}
  }

  return {ok: true, planRevision: planRevision ?? (expectedPlanRevision as number)}
}

const getCompletedImportHistoryCompletion = (history: ProjectTransferHistoryRecord | null) => {
  return history ? parseProjectTransferCompletionPayload(history.completionPayloadJson, 'import') : null
}

const getSessionCompletion = (session: ProjectTransferSessionRecord) => {
  return parseProjectTransferCompletionPayload(session.completionPayloadJson, session.direction)
}

const getHistoryCompletionResult = ({
  history,
  session,
}: {
  history: ProjectTransferHistoryRecord | null
  session: ProjectTransferSessionRecord
}): ProjectTransferCommitResult | null => {
  const historyCompletion = getCompletedImportHistoryCompletion(history)

  return historyCompletion === null
    ? null
    : {completion: historyCompletion, history, session, status: 'completed', statusCode: 200}
}

const getCompletedRetryResult = async ({
  historyRepository,
  session,
}: {
  historyRepository: Pick<
    ReturnType<typeof getProjectTransferHistoryRepository>,
    'getCompletedImportHistoryBySessionId'
  >
  session: ProjectTransferSessionRecord
}): Promise<ProjectTransferCommitResult> => {
  const sessionCompletion = getSessionCompletion(session)
  const history =
    sessionCompletion === null
      ? await historyRepository.getCompletedImportHistoryBySessionId({sessionId: session.id})
      : null
  const historyCompletion = getCompletedImportHistoryCompletion(history)
  const completion = sessionCompletion ?? historyCompletion

  return completion === null
    ? {error: 'Project transfer completed import session is missing completion', status: 'error', statusCode: 409}
    : {completion, history, session, status: 'completed', statusCode: 200}
}

const getExistingCompletionResult = async ({
  historyRepository,
  session,
}: {
  historyRepository: Pick<
    ReturnType<typeof getProjectTransferHistoryRepository>,
    'getCompletedImportHistoryBySessionId'
  >
  session: ProjectTransferSessionRecord
}): Promise<ProjectTransferCommitResult | null> => {
  if (session.state === 'completed') {
    return getCompletedRetryResult({historyRepository, session})
  }

  const history = await historyRepository.getCompletedImportHistoryBySessionId({sessionId: session.id})

  return getHistoryCompletionResult({history, session})
}

const getInvalidSessionResult = ({
  now,
  session,
}: {
  now: Date
  session: ProjectTransferSessionRecord
}): ProjectTransferCommitResult | null => {
  const response = toProjectTransferSessionResponse(session)
  const readyValidation = validateProjectTransferPlanReadyToCommit(response.planSummary)

  return response.direction !== 'import'
    ? {error: 'Project transfer session is not an import session', status: 'error', statusCode: 409}
    : response.state === 'expired' || response.expiresAt.getTime() <= now.getTime()
      ? {error: 'Project transfer import session expired', status: 'error', statusCode: 410}
      : response.state === 'failed'
        ? {error: 'Project transfer import session failed', status: 'error', statusCode: 409}
        : response.state === 'cancelled'
          ? {error: 'Project transfer import session was cancelled', status: 'error', statusCode: 409}
          : response.state !== 'ready_to_commit'
            ? {error: 'Project transfer import session is not ready to commit', status: 'error', statusCode: 409}
            : !readyValidation.ok
              ? {error: readyValidation.error, status: 'error', statusCode: 409}
              : null
}

const assertArtifactConsistency = ({
  plan,
  requestPlanRevision,
  session,
}: {
  plan: ProjectTransferImportPlanArtifact
  requestPlanRevision: number
  session: ProjectTransferSessionRecord
}) => {
  const sessionPlanSummary = parseProjectTransferPlanSummary(session.planSummaryJson)
  const progress = parseProjectTransferProgressPayload(session.progressJson)
  const stagingValidation = validateProjectTransferReviewedPlanStagingRevision({plan, progress})

  if (requestPlanRevision !== session.planRevision) {
    return {error: 'Project transfer commit request planRevision is stale', ok: false as const}
  }

  if (!stagingValidation.ok) {
    return {error: stagingValidation.error, ok: false as const}
  }

  if (plan.planRevision !== session.planRevision) {
    return {error: 'Project transfer commit plan artifact revision is stale', ok: false as const}
  }

  if (getProjectTransferCanonicalJson(sessionPlanSummary) !== getProjectTransferCanonicalJson(plan.summary)) {
    return {error: 'Project transfer commit plan artifact summary is stale', ok: false as const}
  }

  return {ok: true as const}
}

const getTargetPlanComparable = (targetPlan: ProjectTransferTargetPlan) => {
  return revalidatedTargetPlanKeys.reduce<Partial<ProjectTransferTargetPlan>>((comparable, key) => {
    return {...comparable, [key]: targetPlan[key]}
  }, {})
}

const targetPlanRevalidationChanged = ({
  currentPlan,
  freshPlan,
}: {
  currentPlan: ProjectTransferTargetPlan
  freshPlan: ProjectTransferTargetPlan
}) => {
  return (
    getProjectTransferCanonicalJson(getTargetPlanComparable(currentPlan))
    !== getProjectTransferCanonicalJson(getTargetPlanComparable(freshPlan))
  )
}

const getCommitBlocker = ({code, message}: {code: string; message: string}): ProjectTransferPlanBlocker => {
  return {code, message, resolutionKind: 'requires_new_package_or_target_changes', scope: 'commit.revalidation'}
}

const getPlanWithRevalidationBlocker = ({
  blocker,
  plan,
}: {
  blocker: ProjectTransferPlanBlocker
  plan: ProjectTransferImportPlanArtifact
}): ProjectTransferImportPlanArtifact => {
  const existingBlockers = plan.summary.blockers ?? plan.blockers ?? []
  const blockers = existingBlockers.some((entry) => {
    return entry.code === blocker.code && entry.scope === blocker.scope
  })
    ? existingBlockers
    : [...existingBlockers, blocker]
  const summary = {...plan.summary, blockerCount: blockers.length, blockers}

  return {
    ...plan,
    blockers,
    canCommit: false,
    resolutionKinds: {...plan.resolutionKinds, [blocker.code]: blocker.resolutionKind},
    summary,
  }
}

const getPlanWithTargetRevalidation = ({
  freshTarget,
  plan,
}: {
  freshTarget: Awaited<ReturnType<typeof getProjectTransferAnalyzeTargetPlan>>
  plan: ProjectTransferImportPlanArtifact
}) => {
  const stalePlan = {
    ...plan,
    summary: {
      ...plan.summary,
      conflictCounts: {...plan.summary.conflictCounts, ...freshTarget.conflictCounts},
      judgmentConflictStatus: freshTarget.judgmentConflictStatus,
      overlapCounts: {...plan.summary.overlapCounts, ...freshTarget.overlapCounts},
      packageWarnings: [...(plan.summary.packageWarnings ?? []), ...freshTarget.packageWarnings],
      warningCount: (plan.summary.packageWarnings ?? []).length + freshTarget.packageWarnings.length,
    },
    targetPlan: freshTarget.targetPlan,
  }

  return getPlanWithRevalidationBlocker({
    blocker: getCommitBlocker({
      code: 'commit_target_plan_stale',
      message: 'Target articles, prompts, routes, or side effects changed since analysis',
    }),
    plan: stalePlan,
  })
}

const getDependencyResolutionRecord = (plan: ProjectTransferImportPlanArtifact) => {
  return isRecord(plan.dependencyResolution) ? plan.dependencyResolution : {}
}

const getStringRecord = (value: unknown) => {
  return isRecord(value)
    ? Object.entries(value).reduce<Record<string, string>>((mapped, [sourceId, targetId]) => {
        return typeof targetId === 'string' ? {...mapped, [sourceId]: targetId} : mapped
      }, {})
    : {}
}

const getStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const getDependencyResolutionRequestFromPlan = (
  plan: ProjectTransferImportPlanArtifact,
): ProjectTransferDependencyResolutionRequest => {
  const resolution = getDependencyResolutionRecord(plan)
  const providerTargetBySourceId = getStringRecord(resolution.providerTargetBySourceId)
  const modelTargetBySourceId = getStringRecord(resolution.modelTargetBySourceId)

  return {
    autoResolve: false,
    planRevision: plan.planRevision,
    selectedModels: Object.entries(modelTargetBySourceId).map(([sourceModelId, targetModelId]) => {
      return {
        acceptSubstitute: getStringArray(resolution.acceptedSubstituteModelSourceIds).includes(sourceModelId),
        sourceModelId,
        targetModelId,
      }
    }),
    selectedProviderConnections: Object.entries(providerTargetBySourceId).map(
      ([sourceProviderConnectionId, targetProviderConnectionId]) => {
        return {sourceProviderConnectionId, targetProviderConnectionId}
      },
    ),
    unresolvedModels: getStringArray(resolution.unresolvedModelSourceIds).map((sourceModelId) => {
      return {sourceModelId, status: 'missing'}
    }),
    unresolvedProviders: getStringArray(resolution.unresolvedProviderSourceIds).map((sourceProviderConnectionId) => {
      return {sourceProviderConnectionId, status: 'missing'}
    }),
  }
}

const getPlanWithDependencyRevalidationError = ({
  error,
  plan,
}: {
  error: string
  plan: ProjectTransferImportPlanArtifact
}) => {
  return getPlanWithRevalidationBlocker({
    blocker: getCommitBlocker({code: 'commit_dependency_revalidation_failed', message: error}),
    plan,
  })
}

const getCommitRevalidationResult = (plan: ProjectTransferImportPlanArtifact, changed: boolean) => {
  return {changed, plan, ready: validateProjectTransferPlanReadyToCommit(plan.summary).ok}
}

const getResolvedDependencyPlanArtifact = (
  plan: ProjectTransferImportPlanArtifact,
): ProjectTransferCommitResolvedDependencyPlanArtifact => {
  return plan as ProjectTransferCommitResolvedDependencyPlanArtifact
}

export const revalidateProjectTransferCommitPlan = async ({
  analysis,
  layout,
  nextPlanRevision,
  plan,
  repositories,
  ...runtimeOptions
}: ProjectTransferCommitRevalidationInput): Promise<ProjectTransferCommitRevalidationResult> => {
  const payloads = await readExtractedPayloads({...runtimeOptions, layout})
  const freshTarget = await getProjectTransferAnalyzeTargetPlan({
    packageFingerprint: analysis.packageFingerprint,
    payloads,
    runner: repositories?.analyzeTargetRunner ?? undefined,
  })

  if (targetPlanRevalidationChanged({currentPlan: plan.targetPlan, freshPlan: freshTarget.targetPlan})) {
    return getCommitRevalidationResult(
      {...getPlanWithTargetRevalidation({freshTarget, plan}), planRevision: nextPlanRevision},
      true,
    )
  }

  const dependencyResult = await revalidateProjectTransferResolvedDependencies({
    nextPlanRevision,
    payloads,
    plan: getResolvedDependencyPlanArtifact(plan),
    repositories: repositories?.dependencyRepositories,
    request: getDependencyResolutionRequestFromPlan(plan),
  })

  if (dependencyResult.status === 'error') {
    return getCommitRevalidationResult(
      {
        ...getPlanWithDependencyRevalidationError({error: dependencyResult.error, plan}),
        planRevision: nextPlanRevision,
      },
      true,
    )
  }

  return dependencyResult.changed
    ? getCommitRevalidationResult(
        getPlanWithRevalidationBlocker({
          blocker: getCommitBlocker({
            code: 'commit_dependency_plan_stale',
            message: 'Provider, model, judgment, or human review assumptions changed since analysis',
          }),
          plan: dependencyResult.plan,
        }),
        true,
      )
    : getCommitRevalidationResult(plan, false)
}

const getCommitProgress = ({
  artifacts,
  completedBytes = 0,
  completedRows = 0,
  message,
  now,
  percent,
  performanceMetrics,
  planRevision,
  stagingRevision,
  status,
}: {
  artifacts: ProjectTransferCommitArtifacts
  completedBytes?: number
  completedRows?: number
  message: string
  now: Date
  percent: number
  performanceMetrics?: ProjectTransferPerformanceMetrics
  planRevision: number
  stagingRevision?: number | null
  status: ProjectTransferProgressPayload['status']
}): ProjectTransferProgressPayload => {
  const totalBytes = getExtractedAssetBytes(artifacts.analysis)
  const totalRows = getCommitRowCount(artifacts.plan)
  const planStagingRevision = stagingRevision ?? artifacts.plan.stagingRevision ?? null

  return {
    bytesProcessed: completedBytes,
    bytesTotal: totalBytes,
    completedBytes,
    completedRows,
    message,
    percent,
    performanceMetrics,
    phase: 'commit',
    planRevision,
    startedAt: now.toISOString(),
    rowCountProcessed: completedRows,
    rowCountTotal: totalRows,
    ...(planStagingRevision === null ? {} : {stagingRevision: planStagingRevision}),
    status,
    totalBytes,
    totalRows,
    updatedAt: now.toISOString(),
    warningCount: artifacts.plan.summary.warningCount,
  }
}

const writeProjectTransferCommitRuntimeEvent = ({
  ownerToken,
  progress,
  sessionId,
  state,
}: {
  ownerToken?: string | null
  progress: ProjectTransferProgressPayload
  sessionId: string
  state: ProjectTransferRuntimeEvent['state']
}): ProjectTransferRuntimeEvent => {
  const timestamp = progress.updatedAt ?? new Date().toISOString()
  const event = {
    bytesProcessed: progress.bytesProcessed ?? null,
    bytesTotal: progress.bytesTotal ?? null,
    direction: 'import' as const,
    eventId: randomUUID(),
    eventType: 'commit_progress' as const,
    message: progress.message ?? null,
    ownerToken,
    phase: progress.phase,
    planRevision: progress.planRevision ?? 0,
    percent: progress.percent ?? null,
    rowCountProcessed: progress.rowCountProcessed ?? null,
    rowCountTotal: progress.rowCountTotal ?? null,
    sessionId,
    state,
    status: progress.status,
    timestamp,
    warningCount: progress.warningCount ?? null,
  }

  writeRuntimeLogEvent({
    attrs: event,
    event: 'project_transfer.commit_progress',
    message: progress.message ?? 'Project transfer commit progress',
    severity: progress.status === 'failed' ? 'ERROR' : 'INFO',
    timestamp,
  })

  return event
}

const getErrorPayload = (error: unknown) => {
  return error instanceof Error ? {message: error.message, name: error.name} : {message: String(error)}
}

const getErrorLogAttrs = (error: unknown) => {
  return error instanceof Error
    ? {errorMessage: error.message, errorName: error.name}
    : {errorMessage: String(error), errorName: 'Error'}
}

const logProjectTransferCommitHeartbeatError = (sessionId: string, error: unknown) => {
  writeRuntimeLogEvent({
    attrs: {sessionId, ...getErrorLogAttrs(error)},
    event: 'project_transfer.commit_worker.heartbeat_error',
    message: 'Project transfer commit heartbeat failed',
    severity: 'WARN',
  })
}

const startDetachedProjectTransferImportCommit = (operation: () => Promise<void>) => {
  queueMicrotask(() => {
    void operation()
  })
}

const persistPreClaimStalePlan = async ({
  artifacts,
  nextPlan,
  now,
  repositories,
  runtimeOptions,
  sessionId,
}: {
  artifacts: ProjectTransferCommitArtifacts
  nextPlan: ProjectTransferImportPlanArtifact
  now: Date
  repositories: Required<Pick<ProjectTransferCommitRepositories, 'sessionRepository'>>
  runtimeOptions: RuntimePathOptions
  sessionId: string
}) => {
  const updated = await repositories.sessionRepository.updateProjectTransferSessionPlanRevision({
    expectedOwnerToken: null,
    expectedPlanRevision: artifacts.plan.planRevision,
    expectedStagingRevision: artifacts.plan.stagingRevision ?? null,
    nextState: 'awaiting_resolution',
    now,
    planSummary: nextPlan.summary,
    sessionId,
  })

  if (updated !== null) {
    await writePlanArtifact({layout: artifacts.layout, plan: nextPlan, runtimeOptions})
  }

  return updated
}

const persistPostClaimStalePlan = async ({
  artifacts,
  commitId,
  nextPlan,
  now,
  ownerToken,
  repositories,
  runtimeOptions,
  session,
}: {
  artifacts: ProjectTransferCommitArtifacts
  commitId: string
  nextPlan: ProjectTransferImportPlanArtifact
  now: Date
  ownerToken: string
  repositories: Required<Pick<ProjectTransferCommitRepositories, 'sessionRepository'>>
  runtimeOptions: RuntimePathOptions
  session: ProjectTransferSessionRecord
}) => {
  const reopened = await repositories.sessionRepository.reopenProjectTransferCommitSession({
    commitId,
    expectedPlanRevision: session.planRevision,
    now,
    ownerToken,
    planSummary: nextPlan.summary,
    sessionId: session.id,
  })

  if (reopened !== null) {
    await writePlanArtifact({layout: artifacts.layout, plan: nextPlan, runtimeOptions})
  }

  return reopened
}

const getPostClaimRevalidationResult = async ({
  artifacts,
  claimed,
  commitId,
  inputRepositories,
  now,
  ownerToken,
  repositories,
  runtimeOptions,
}: {
  artifacts: ProjectTransferCommitArtifacts
  claimed: ProjectTransferSessionRecord
  commitId: string
  inputRepositories?: ProjectTransferCommitRepositories
  now: Date
  ownerToken: string
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
}) => {
  const postClaimRevalidationMeasurement = await measureProjectTransferPhase('revalidation', () => {
    return repositories.revalidate({
      ...runtimeOptions,
      analysis: artifacts.analysis,
      layout: artifacts.layout,
      nextPlanRevision: claimed.planRevision + 1,
      plan: artifacts.plan,
      repositories: inputRepositories,
    })
  })
  const postClaimRevalidation = postClaimRevalidationMeasurement.value
  const performanceMetrics = mergeProjectTransferPerformanceMetrics(
    getImportPerformanceMetrics(postClaimRevalidation.performanceMetrics),
    getProjectTransferPerformanceMetrics({
      benchmark: {
        revalidationOutcome: {changed: postClaimRevalidation.changed, ready: postClaimRevalidation.ready},
        wallTimeMs: postClaimRevalidationMeasurement.timing.durationMs,
      },
      operation: 'import',
      phases: {revalidation: postClaimRevalidationMeasurement.timing},
    }),
  )

  if (!postClaimRevalidation.ready || postClaimRevalidation.changed) {
    const reopened = await persistPostClaimStalePlan({
      artifacts,
      commitId,
      nextPlan: postClaimRevalidation.plan,
      now,
      ownerToken,
      repositories,
      runtimeOptions,
      session: claimed,
    })

    return reopened === null
      ? {error: 'Project transfer commit could not reopen claimed stale plan', ok: false as const}
      : {ok: true as const, performanceMetrics, session: reopened, stalePlan: postClaimRevalidation.plan}
  }

  return {artifacts: {...artifacts, plan: postClaimRevalidation.plan}, ok: true as const, performanceMetrics}
}

const getRepositorySet = (repositories?: ProjectTransferCommitRepositories) => {
  return {
    getCommitId: repositories?.getCommitId ?? randomUUID,
    getOwnerToken: repositories?.getOwnerToken ?? randomUUID,
    historyRepository: repositories?.historyRepository ?? getProjectTransferHistoryRepository(),
    revalidate: repositories?.revalidate ?? revalidateProjectTransferCommitPlan,
    runAppTableWrites: repositories?.runAppTableWrites ?? runProjectTransferCommitAppTableWrites,
    sessionRepository: repositories?.sessionRepository ?? getProjectTransferSessionRepository(),
    startBackgroundCommit: repositories?.startBackgroundCommit ?? startDetachedProjectTransferImportCommit,
  }
}

const runProjectTransferCommitAppTableWrites = async ({
  artifacts,
  commitId,
  now,
  schemaVersion,
  sessionId,
  ...runtimeOptions
}: RuntimePathOptions & {
  artifacts: ProjectTransferCommitArtifacts
  commitId: string
  now: Date
  schemaVersion: number
  sessionId: string
}) => {
  const stagingLoad = await measureProjectTransferPhase('stagingLoad', () => {
    return readExtractedPayloads({...runtimeOptions, layout: artifacts.layout})
  })
  const payloads = stagingLoad.value
  const assetPromotion = await measureProjectTransferPhase('assetPromotion', () => {
    return promoteProjectTransferCommitAssets({...runtimeOptions, layout: artifacts.layout, now, sessionId})
  })

  try {
    const appTableWrites = await measureProjectTransferPhase('appTableWrites', () => {
      return writeProjectTransferCommitAppTables({
        commitId,
        now,
        payloads,
        plan: artifacts.plan,
        promotion: assetPromotion.value,
        schemaVersion,
        sessionId,
      })
    })
    const phaseMetrics = getProjectTransferPerformanceMetrics({
      benchmark: {
        finalAssetBytes: artifacts.analysis.assetSummary.actualByteLength,
        packageFingerprint: artifacts.analysis.packageFingerprint ?? undefined,
        schemaVersion,
      },
      bytes: {
        assetBytes: artifacts.analysis.assetSummary.actualByteLength,
        expandedArchiveBytes: artifacts.analysis.archive.expandedBytes,
        packageBytes: artifacts.analysis.archive.packageSizeBytes,
      },
      operation: 'import',
      phases: {
        appTableWrites: appTableWrites.timing,
        assetPromotion: assetPromotion.timing,
        stagingLoad: stagingLoad.timing,
      },
      rows: getProjectTransferPerformanceRowCountersFromPayloads(payloads),
      warnings: artifacts.plan.summary.packageWarnings ?? [],
    })
    const performanceMetrics = mergeProjectTransferPerformanceMetrics(
      phaseMetrics,
      appTableWrites.value.performanceMetrics ?? getProjectTransferPerformanceMetrics({operation: 'import'}),
    )

    return {...appTableWrites.value, performanceMetrics}
  } catch (error) {
    await measureProjectTransferPhase('cleanup', () => {
      return rollbackProjectTransferCommitPromotion({
        ...runtimeOptions,
        manifest: assetPromotion.value.manifest,
        sessionId,
      }).catch(() => {
        return undefined
      })
    })
    throw error
  }
}

const settleCompletionSideEffect = async <TValue>(operation: Promise<TValue>) => {
  return operation.then(
    (value) => {
      return value
    },
    () => {
      return null
    },
  )
}

type ProjectTransferCommitRepositorySet = ReturnType<typeof getRepositorySet>

const updateClaimedCommitProgress = async ({
  ownerToken,
  progress,
  repositories,
  sessionId,
}: {
  ownerToken: string
  progress: ProjectTransferProgressPayload
  repositories: ProjectTransferCommitRepositorySet
  sessionId: string
}) => {
  const updated = await repositories.sessionRepository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'committing',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'committing',
    now: new Date(progress.updatedAt ?? Date.now()),
    progress,
    sessionId,
  })

  writeProjectTransferCommitRuntimeEvent({ownerToken, progress, sessionId, state: updated?.state ?? 'committing'})

  return updated
}

const refreshClaimedCommitHeartbeat = async ({
  ownerToken,
  progress,
  repositories,
  sessionId,
}: {
  ownerToken: string
  progress: ProjectTransferProgressPayload
  repositories: ProjectTransferCommitRepositorySet
  sessionId: string
}) => {
  const heartbeat = await repositories.sessionRepository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'committing',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'committing',
    progress,
    sessionId,
  })

  if (heartbeat === null) {
    throw new Error(`Project transfer commit session ownership was lost: ${sessionId}`)
  }

  return heartbeat
}

const runClaimedCommitHeartbeatOperation = async <TValue>({
  operation,
  ownerToken,
  progress,
  repositories,
  sessionId,
}: {
  operation: () => Promise<TValue>
  ownerToken: string
  progress: ProjectTransferProgressPayload
  repositories: ProjectTransferCommitRepositorySet
  sessionId: string
}) => {
  const interval = setInterval(() => {
    void refreshClaimedCommitHeartbeat({ownerToken, progress, repositories, sessionId}).catch((error) => {
      logProjectTransferCommitHeartbeatError(sessionId, error)
    })
  }, commitWorkerHeartbeatIntervalMs)

  return operation().finally(() => {
    clearInterval(interval)
  })
}

const failClaimedCommit = async ({
  artifacts,
  error,
  ownerToken,
  repositories,
  sessionId,
}: {
  artifacts: ProjectTransferCommitArtifacts
  error: unknown
  ownerToken: string
  repositories: ProjectTransferCommitRepositorySet
  sessionId: string
}) => {
  const now = new Date()
  const progress = getCommitProgress({
    artifacts,
    completedBytes: getExtractedAssetBytes(artifacts.analysis),
    message: 'Commit failed; rollback cleanup completed or was not required',
    now,
    percent: 100,
    planRevision: artifacts.plan.planRevision,
    status: 'failed',
  })
  const failed = await repositories.sessionRepository.transitionProjectTransferSessionState({
    error: getErrorPayload(error),
    expectedOwnerToken: ownerToken,
    expectedState: 'committing',
    nextOwnerToken: null,
    nextState: 'failed',
    now,
    progress,
    sessionId,
  })

  writeProjectTransferCommitRuntimeEvent({ownerToken, progress, sessionId, state: failed?.state ?? 'failed'})

  return failed
}

const getCommitErrorResult = (error: unknown): ProjectTransferCommitResult => {
  return {error: error instanceof Error ? error.message : String(error), status: 'error', statusCode: 500}
}

const runClaimedProjectTransferImportCommit = async ({
  artifacts,
  claimed,
  commitId,
  now,
  ownerToken,
  performanceMetrics,
  repositories,
  runtimeOptions,
  sessionId,
}: {
  artifacts: ProjectTransferCommitArtifacts
  claimed: ProjectTransferSessionRecord
  commitId: string
  now: Date
  ownerToken: string
  performanceMetrics?: ProjectTransferPerformanceMetrics | null
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
  sessionId: string
}): Promise<ProjectTransferCommitResult> => {
  try {
    const writeProgress = getCommitProgress({
      artifacts,
      completedBytes: getExtractedAssetBytes(artifacts.analysis),
      message: 'Commit asset promotion and app-table writes running',
      now: new Date(),
      percent: 25,
      planRevision: claimed.planRevision,
      status: 'running',
    })
    const progressed = await updateClaimedCommitProgress({ownerToken, progress: writeProgress, repositories, sessionId})

    if (progressed === null) {
      return {
        error: 'Project transfer import commit ownership was lost before writes',
        status: 'error',
        statusCode: 409,
      }
    }

    const writeResult = await runClaimedCommitHeartbeatOperation({
      operation: () => {
        return repositories.runAppTableWrites({
          artifacts,
          commitId,
          now,
          schemaVersion: getAnalysisSchemaVersion(artifacts.analysis),
          ...runtimeOptions,
          sessionId,
        })
      },
      ownerToken,
      progress: writeProgress,
      repositories,
      sessionId,
    })
    const completionNow = new Date()
    const completedPerformanceMetrics = getCommitPerformanceMetrics({
      artifacts,
      baseMetrics: performanceMetrics,
      writeMetrics: writeResult.performanceMetrics,
    })
    const completedProgress = getCommitProgress({
      artifacts,
      completedBytes: getExtractedAssetBytes(artifacts.analysis),
      completedRows: getCommitRowCount(artifacts.plan),
      message: 'Commit transaction completed',
      now: completionNow,
      percent: 100,
      performanceMetrics: completedPerformanceMetrics,
      planRevision: claimed.planRevision,
      status: 'completed',
    })

    await settleCompletionSideEffect(
      updateClaimedCommitProgress({ownerToken, progress: completedProgress, repositories, sessionId}),
    )

    const completedSession = await settleCompletionSideEffect(
      repositories.sessionRepository.persistProjectTransferSessionCompletion({
        completionPayload: writeResult.completion,
        expectedPlanRevision: claimed.planRevision,
        now: completionNow,
        ownerToken,
        sessionId,
      }),
    )
    await settleCompletionSideEffect(
      writeCompletionArtifact({completion: writeResult.completion, layout: artifacts.layout, runtimeOptions}),
    )
    await settleCompletionSideEffect(
      cleanupCompletedImportArtifacts({layout: artifacts.layout, repositories, runtimeOptions, sessionId}),
    )

    return {
      completion: writeResult.completion,
      history: writeResult.history,
      session: completedSession ?? claimed,
      status: 'completed',
      statusCode: 200,
    }
  } catch (error) {
    await settleCompletionSideEffect(failClaimedCommit({artifacts, error, ownerToken, repositories, sessionId}))
    return getCommitErrorResult(error)
  }
}

export const commitProjectTransferImportSession = async ({
  now: inputNow,
  repositories: inputRepositories,
  request,
  sessionId,
  ...runtimeOptions
}: ProjectTransferCommitInput): Promise<ProjectTransferCommitResult> => {
  const revision = getReviewedPlanRevision(request)

  if (!revision.ok) {
    return {error: revision.error, status: 'error', statusCode: 400}
  }

  const repositories = getRepositorySet(inputRepositories)
  const now = inputNow ?? new Date()
  const current = await repositories.sessionRepository.getProjectTransferSession({sessionId})

  if (current === null) {
    return {error: 'Project transfer import session not found', status: 'error', statusCode: 404}
  }

  const existingCompletion = await getExistingCompletionResult({
    historyRepository: repositories.historyRepository,
    session: current,
  })

  if (existingCompletion !== null) {
    return existingCompletion
  }

  if (current.state === 'committing') {
    return {session: current, status: 'in_flight', statusCode: 202}
  }

  const invalidSession = getInvalidSessionResult({now, session: current})

  if (invalidSession !== null) {
    return invalidSession
  }

  const artifacts = await loadProjectTransferCommitArtifacts({...runtimeOptions, session: current, sessionId})
  const executionMode = getCommitExecutionMode(artifacts)
  const expectedStagingRevision = getProjectTransferProgressStagingRevision(
    parseProjectTransferProgressPayload(current.progressJson),
  )
  const artifactConsistency = assertArtifactConsistency({
    plan: artifacts.plan,
    requestPlanRevision: revision.planRevision,
    session: current,
  })

  if (!artifactConsistency.ok) {
    return {error: artifactConsistency.error, status: 'error', statusCode: 409}
  }

  if (executionMode !== 'background') {
    const preClaimRevalidationMeasurement = await measureProjectTransferPhase('revalidation', () => {
      return repositories.revalidate({
        ...runtimeOptions,
        analysis: artifacts.analysis,
        layout: artifacts.layout,
        nextPlanRevision: current.planRevision + 1,
        plan: artifacts.plan,
        repositories: inputRepositories,
      })
    })
    const preClaimRevalidation = preClaimRevalidationMeasurement.value

    if (!preClaimRevalidation.ready || preClaimRevalidation.changed) {
      const reopened = await persistPreClaimStalePlan({
        artifacts,
        nextPlan: preClaimRevalidation.plan,
        now,
        repositories,
        runtimeOptions,
        sessionId,
      })

      return reopened === null
        ? {error: 'Project transfer commit could not reopen stale plan', status: 'error', statusCode: 409}
        : {plan: preClaimRevalidation.plan, session: reopened, status: 'stale', statusCode: 200}
    }
  }

  const commitId = repositories.getCommitId()
  const ownerToken = repositories.getOwnerToken()
  const claimProgress = getCommitProgress({
    artifacts,
    message: 'Commit claimed',
    now,
    percent: 0,
    planRevision: revision.planRevision,
    status: 'running',
  })
  const claimed = await repositories.sessionRepository.transitionProjectTransferSessionState({
    commitId,
    expectedOwnerToken: null,
    expectedPlanRevision: revision.planRevision,
    expectedStagingRevision,
    expectedState: 'ready_to_commit',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'committing',
    now,
    progress: claimProgress,
    sessionId,
  })

  if (claimed === null) {
    const refreshed = await repositories.sessionRepository.getProjectTransferSession({sessionId})

    return refreshed?.state === 'committing'
      ? {session: refreshed, status: 'in_flight', statusCode: 202}
      : {error: 'Project transfer import commit could not be claimed', status: 'error', statusCode: 409}
  }

  writeProjectTransferCommitRuntimeEvent({ownerToken, progress: claimProgress, sessionId, state: claimed.state})

  const runClaimed = (
    claimedArtifacts: ProjectTransferCommitArtifacts,
    performanceMetrics?: ProjectTransferPerformanceMetrics | null,
  ) => {
    return runClaimedProjectTransferImportCommit({
      artifacts: claimedArtifacts,
      claimed,
      commitId,
      now,
      ownerToken,
      performanceMetrics,
      repositories,
      runtimeOptions,
      sessionId,
    })
  }

  if (executionMode === 'background') {
    repositories.startBackgroundCommit(async () => {
      const revalidation = await getPostClaimRevalidationResult({
        artifacts,
        claimed,
        commitId,
        inputRepositories,
        now,
        ownerToken,
        repositories,
        runtimeOptions,
      })

      if ('artifacts' in revalidation) {
        await runClaimed(revalidation.artifacts, revalidation.performanceMetrics)
      }
    })

    return {commitId, executionMode, session: claimed, status: 'claimed', statusCode: 202}
  }

  const postClaimRevalidation = await getPostClaimRevalidationResult({
    artifacts,
    claimed,
    commitId,
    inputRepositories,
    now,
    ownerToken,
    repositories,
    runtimeOptions,
  })

  return 'artifacts' in postClaimRevalidation
    ? runClaimed(postClaimRevalidation.artifacts, postClaimRevalidation.performanceMetrics)
    : postClaimRevalidation.stalePlan
      ? {
          plan: postClaimRevalidation.stalePlan,
          session: postClaimRevalidation.session,
          status: 'stale',
          statusCode: 200,
        }
      : {error: postClaimRevalidation.error, status: 'error', statusCode: 409}
}

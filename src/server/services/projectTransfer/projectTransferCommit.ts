import {randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {createInterface} from 'node:readline'

import type {ProjectTransferHistoryRecord, ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
import {
  postImportReviewServingBuildPriority,
  requestReviewServingV4Rebuild,
  type RequestReviewServingV4RebuildInput,
} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {writeRuntimeLogEvent, writeRuntimeOperatorLogEvent} from '../../utils/runtimeLogger.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import type {
  ProjectTransferImportAnalysisArtifact,
  ProjectTransferImportPlanArtifact,
} from './projectTransferAnalyze.ts'
import {
  getProjectTransferAnalyzeTargetPlan,
  type ProjectTransferAnalyzeTargetRunner,
  type ProjectTransferTargetPlan,
} from './projectTransferAnalyzeTarget.ts'
import {runWithProjectTransferBackgroundActivity} from './projectTransferBackgroundActivity.ts'
import {writeProjectTransferCanonicalJsonArtifact} from './projectTransferCanonicalJsonArtifact.ts'
import {getProjectTransferPlanWithCommitIdMaps} from './projectTransferCommitIdMaps.ts'
import {
  promoteProjectTransferCommitAssets,
  rollbackProjectTransferCommitPromotion,
} from './projectTransferCommitRollback.ts'
import {
  isProjectTransferCommitTargetStateChangedError,
  type ProjectTransferCommitTargetStateChangedError,
} from './projectTransferCommitWriteGuard.ts'
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
  type ProjectTransferOverallProgress,
  type ProjectTransferPlanBlocker,
  type ProjectTransferPlanSummary,
  type ProjectTransferProgressPayload,
  type ProjectTransferRuntimeEvent,
  type ProjectTransferSessionResponse,
  toProjectTransferSessionResponse,
  validateProjectTransferPlanReadyToCommit,
} from './projectTransferContracts.ts'
import {
  projectTransferCommitRevalidationScope,
  type ProjectTransferDependencyResolutionRepositories,
  type ProjectTransferDependencyResolutionRequest,
  type ProjectTransferDependencyResolutionState,
  revalidateProjectTransferResolvedDependencies,
} from './projectTransferDependencyResolution.ts'
import {
  getProjectTransferDirtyTokenRevalidationDecision,
  getProjectTransferDirtyTokenStalePlanReasons,
  type ProjectTransferDirtyTokenRevalidationDecision,
} from './projectTransferDirtyTokenRevalidation.ts'
import {
  type ProjectTransferDuckdbExclusiveWorkLease,
  runWithDuckdbExclusiveWork,
  updateActiveDuckdbExclusiveWorkProgress,
} from './projectTransferDuckdbExclusiveWork.ts'
import {getProjectTransferCanonicalJson} from './projectTransferFingerprint.ts'
import {getProjectTransferHistoryRepository} from './projectTransferHistoryRepository.ts'
import {
  type ProjectTransferOperationTableRunner,
  withProjectTransferOperationTables,
} from './projectTransferOperationTables.ts'
import {resolveProjectTransferTempWritablePath} from './projectTransferPaths.ts'
import {
  assertProjectTransferPayloadRow,
  parseProjectTransferPayload,
  type ProjectTransferPayload,
  type ProjectTransferPayloadByKey,
  type ProjectTransferPayloadRecord,
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
import {
  createProjectTransferOverallProgressTracker,
  createProjectTransferProgressPublisher,
  type ProjectTransferOverallProgressTracker,
} from './projectTransferProgressPublisher.ts'
import {
  getProjectTransferCommitWriterFraction,
  getProjectTransferOverallProgressStepLabel,
  getProjectTransferRevalidationFraction,
  getProjectTransferTargetAnalysisFraction,
  type ProjectTransferCommitWriterStepProgress,
  type ProjectTransferRevalidationProgress,
  type ProjectTransferTargetAnalysisProgress,
  projectTransferTargetAnalysisStepShares,
} from './projectTransferProgressWeights.ts'
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout, type ProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferSessionRepository} from './projectTransferSessionRepository.ts'
import {
  getProjectTransferCurrentImportStagingLayout,
  getProjectTransferProgressStagingRevision,
  validateProjectTransferReviewedPlanStagingRevision,
} from './projectTransferStaging.ts'
import {
  getProjectTransferTargetStateDirtyTokenService,
  type ProjectTransferTargetStateDirtyTokenSnapshot,
} from './projectTransferTargetStateDirtyTokenService.ts'
import {projectTransferCommitTransactionWorkloadContext} from './projectTransferWorkloadContext.ts'

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
  reclaimRevalidationMemory?: (lease: ProjectTransferDuckdbExclusiveWorkLease) => Promise<unknown>
  revalidate?: (input: ProjectTransferCommitRevalidationInput) => Promise<ProjectTransferCommitRevalidationResult>
  requestReviewServingBuild?: (input: RequestReviewServingV4RebuildInput) => Promise<unknown>
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
  heartbeatIntervalMs?: number
  progressThrottleMs?: number
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
  onProgress?: (progress: ProjectTransferRevalidationProgress) => Promise<void> | void
  plan: ProjectTransferImportPlanArtifact
  repositories?: Pick<ProjectTransferCommitRepositories, 'analyzeTargetRunner' | 'dependencyRepositories'>
  sessionId?: string
}

export type ProjectTransferCommitProgressOptions = {persist?: 'artifact' | 'session'; throttled?: boolean}

type ProjectTransferCommitProgressPublisher = (
  progress: ProjectTransferProgressPayload,
  options?: ProjectTransferCommitProgressOptions,
) => Promise<void>

type ProjectTransferCommitProgressContext = {
  getActiveProgress: () => ProjectTransferProgressPayload
  overall: ProjectTransferOverallProgressTracker<'commit'>
  publish: ProjectTransferCommitProgressPublisher
  publishSessionProgress: (progress: ProjectTransferProgressPayload) => Promise<ProjectTransferSessionRecord | null>
  scheduler: ReturnType<typeof createProjectTransferProgressPublisher>
}

type ProjectTransferCommitRevalidationResult = {
  changed: boolean
  performanceMetrics?: ProjectTransferPerformanceMetrics
  plan: ProjectTransferImportPlanArtifact
  ready: boolean
}

type ProjectTransferCommitRevalidationContext = {
  currentTargetState: ProjectTransferTargetStateDirtyTokenSnapshot | null
  dirtyTokenDecision: ProjectTransferDirtyTokenRevalidationDecision
}

type ProjectTransferCommitResolvedDependencyPlanArtifact = ProjectTransferImportPlanArtifact & {
  dependencyResolution?: ProjectTransferDependencyResolutionState
}

type ProjectTransferCommitAppTableWriteInput = RuntimePathOptions & {
  artifacts: ProjectTransferCommitArtifacts
  commitId: string
  now: Date
  onProgress?: ProjectTransferCommitProgressPublisher
  overallProgress?: ProjectTransferOverallProgressTracker<'commit'>
  schemaVersion: number
  sessionId: string
}

type ProjectTransferCommitWriterDatabase = NonNullable<
  Parameters<typeof writeProjectTransferCommitAppTables>[0]['database']
>

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
const retryableCommitFailureMessage = 'Commit failed; rollback cleanup completed or was not required'

const writeCommitProgressArtifact = async ({
  progress,
  runtimeOptions,
  sessionId,
}: {
  progress: ProjectTransferProgressPayload
  runtimeOptions: RuntimePathOptions
  sessionId: string
}) => {
  const layout = getProjectTransferImportTempLayout(sessionId)
  const progressPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue: layout.progressPath})

  await writeProjectTransferCanonicalJsonArtifact({filePath: progressPath, value: progress})
}

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
  const cleanupPaths = [
    layout.analysisPath,
    layout.commitTempTablesPath,
    layout.extractedPath,
    layout.manifestPath,
    layout.planPath,
    layout.promotionManifestPath,
    layout.uploadPath,
  ]

  await Promise.all(
    cleanupPaths.map((pathValue) => {
      const resolvedPath = resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue})

      return rm(resolvedPath, {force: true, recursive: true})
    }),
  )
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

const readCompactExtractedJudgments = async (
  input: RuntimePathOptions & {layout: ProjectTransferImportTempLayout},
): Promise<ProjectTransferPayloadRecord[]> => {
  const pathValue = getPayloadPath(input.layout, 'judgments')
  const resolvedPath = resolveProjectTransferTempWritablePath({...input, pathValue})
  const file = globalThis.Bun.file(resolvedPath)

  if (!(await file.exists())) {
    return getCommitError(`missing ${pathValue}`)
  }

  const records: ProjectTransferPayloadRecord[] = []
  const lines = createInterface({crlfDelay: Number.POSITIVE_INFINITY, input: createReadStream(resolvedPath)})

  for await (const line of lines) {
    if (line.trim() !== '') {
      const row = assertProjectTransferPayloadRow('judgments', JSON.parse(line) as unknown, records.length)
      records.push({sourceJudgmentId: row.sourceJudgmentId})
    }
  }

  return records
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

const getPercentFromCounts = ({completed, total}: {completed: number; total: number}) => {
  return total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : 100
}

const formatCommitPayloadKey = (key: string) => {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_:-]+/g, ' ')
    .toLowerCase()
}

const readExtractedPayloads = async (
  input: RuntimePathOptions & {
    artifacts?: ProjectTransferCommitArtifacts
    layout: ProjectTransferImportTempLayout
    onPayloadRead?: (progress: {completedItems: number; totalItems: number}) => Promise<void> | void
    onProgress?: ProjectTransferCommitProgressPublisher
    overallProgress?: ProjectTransferOverallProgressTracker<'commit'>
    phaseStartedAt?: Date
    retainCompactJudgments?: boolean
  },
) => {
  const payloads: Partial<ProjectTransferPayloadByKey> = {}
  const totalItems = projectTransferPayloadKeys.length
  const phaseStartedAt = input.phaseStartedAt ?? new Date()

  await projectTransferPayloadKeys.reduce<Promise<number>>(async (previous, key, index) => {
    const completedRows = await previous
    const nextCompletedRows = completedRows + (input.artifacts ? getPackageCount(input.artifacts.plan, key) : 0)

    if (input.artifacts && input.onProgress) {
      await input.onProgress(
        getCommitProgress({
          artifacts: input.artifacts,
          completedItems: index,
          completedRows,
          includeBytes: false,
          message: `Loading package payload ${formatCommitPayloadKey(key)}`,
          now: new Date(),
          overall: input.overallProgress?.update({step: 'loadPayloads', stepFraction: index / totalItems}),
          percent: getPercentFromCounts({completed: index, total: totalItems}),
          phase: 'staging_load',
          phaseStartedAt,
          planRevision: input.artifacts.plan.planRevision,
          status: 'running',
          totalItems,
        }),
        {throttled: index > 0},
      )
    }

    payloads[key] = (await (input.retainCompactJudgments && key === 'judgments'
      ? readCompactExtractedJudgments(input)
      : readExtractedPayload({...input, key}))) as ProjectTransferPayload

    await input.onPayloadRead?.({completedItems: index + 1, totalItems})

    if (input.artifacts && input.onProgress) {
      await input.onProgress(
        getCommitProgress({
          artifacts: input.artifacts,
          completedItems: index + 1,
          completedRows: nextCompletedRows,
          includeBytes: false,
          message: `Loaded package payload ${formatCommitPayloadKey(key)}`,
          now: new Date(),
          overall: input.overallProgress?.update({step: 'loadPayloads', stepFraction: (index + 1) / totalItems}),
          percent: getPercentFromCounts({completed: index + 1, total: totalItems}),
          phase: 'staging_load',
          phaseStartedAt,
          planRevision: input.artifacts.plan.planRevision,
          status: index + 1 === totalItems ? 'completed' : 'running',
          totalItems,
        }),
        {throttled: index + 1 < totalItems},
      )
    }

    return nextCompletedRows
  }, Promise.resolve(0))

  return payloads
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
    expandedBytes: artifacts.analysis.archive.expandedBytes,
    extractedAssetBytes: getExtractedAssetBytes(artifacts.analysis),
    judgmentCount: getPackageCount(artifacts.plan, 'judgments'),
    packageBytes: artifacts.analysis.archive.packageSizeBytes,
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

export const isProjectTransferFailedCommitRetryCandidate = (response: ProjectTransferSessionResponse) => {
  return (
    response.direction === 'import'
    && response.state === 'failed'
    && response.ownerToken === null
    && response.commitId !== null
    && response.progress?.phase === 'commit'
    && response.progress.status === 'failed'
    && response.progress.message === retryableCommitFailureMessage
    && response.progress.planRevision === response.planRevision
    && response.planSummary?.packageCounts?.assetManifest === 0
    && validateProjectTransferPlanReadyToCommit(response.planSummary).ok
  )
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
  const isFailedCommitRetry = isProjectTransferFailedCommitRetryCandidate(response)

  return response.direction !== 'import'
    ? {error: 'Project transfer session is not an import session', status: 'error', statusCode: 409}
    : response.state === 'expired' || response.expiresAt.getTime() <= now.getTime()
      ? {error: 'Project transfer import session expired', status: 'error', statusCode: 410}
      : response.state === 'failed' && !isFailedCommitRetry
        ? {error: 'Project transfer import session failed', status: 'error', statusCode: 409}
        : response.state === 'cancelled'
          ? {error: 'Project transfer import session was cancelled', status: 'error', statusCode: 409}
          : response.state !== 'ready_to_commit' && !isFailedCommitRetry
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
  return {
    code,
    message,
    resolutionKind: 'requires_new_package_or_target_changes',
    scope: projectTransferCommitRevalidationScope,
  }
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

const getCommitDependencyRepositories = ({
  analyzeTargetRunner,
  repositories,
}: {
  analyzeTargetRunner?: ProjectTransferAnalyzeTargetRunner
  repositories?: ProjectTransferCommitRevalidationInput['repositories']
}) => {
  const dependencyRepositories = repositories?.dependencyRepositories

  return dependencyRepositories?.analyzeTargetRunner === undefined && analyzeTargetRunner !== undefined
    ? {...dependencyRepositories, analyzeTargetRunner}
    : dependencyRepositories
}

const getCommitAnalyzeTargetRunner = ({
  analyzeTargetRunner,
  repositories,
}: {
  analyzeTargetRunner?: ProjectTransferAnalyzeTargetRunner
  repositories?: ProjectTransferCommitRevalidationInput['repositories']
}) => {
  return repositories?.analyzeTargetRunner ?? analyzeTargetRunner
}

const getCurrentTargetStateDirtyTokenSnapshotForCommit = async (runner?: ProjectTransferAnalyzeTargetRunner | null) => {
  return runner === null
    ? null
    : runner === undefined
      ? getProjectTransferTargetStateDirtyTokenService().getTargetStateDirtyTokenSnapshot()
      : runner.run === undefined
        ? null
        : getProjectTransferTargetStateDirtyTokenService().getTargetStateDirtyTokenSnapshot({runner})
}

const getCommitRevalidationContext = async ({
  plan,
  repositories,
}: {
  plan: ProjectTransferImportPlanArtifact
  repositories?: ProjectTransferCommitRevalidationInput['repositories']
}): Promise<ProjectTransferCommitRevalidationContext> => {
  const targetStateRunner =
    repositories?.analyzeTargetRunner ?? repositories?.dependencyRepositories?.analyzeTargetRunner
  const currentTargetState = await getCurrentTargetStateDirtyTokenSnapshotForCommit(targetStateRunner)
  const dirtyTokenDecision = getProjectTransferDirtyTokenRevalidationDecision({
    analyzedTargetState: plan.targetState,
    currentTargetState,
  })

  return {currentTargetState, dirtyTokenDecision}
}

const getPlanWithCommitRevalidationContext = ({
  context,
  plan,
}: {
  context: ProjectTransferCommitRevalidationContext
  plan: ProjectTransferImportPlanArtifact
}): ProjectTransferImportPlanArtifact => {
  const stalePlanReasons = getProjectTransferDirtyTokenStalePlanReasons(context.dirtyTokenDecision)

  return {
    ...plan,
    stalePlanReasons,
    summary: {...plan.summary, stalePlanReasons},
    targetState: context.currentTargetState ?? plan.targetState ?? null,
  }
}

const getRevalidationPayloadReporter = (onProgress: ProjectTransferCommitRevalidationInput['onProgress']) => {
  return {
    onPayloadRead: ({completedItems, totalItems}: {completedItems: number; totalItems: number}) => {
      return onProgress?.({
        message: 'Reading staged payloads',
        part: 'payloads',
        partFraction: completedItems / totalItems,
      })
    },
  }
}

const getRevalidationTargetAnalysisReporter = (onProgress: ProjectTransferCommitRevalidationInput['onProgress']) => {
  return {
    onProgress: (progress: ProjectTransferTargetAnalysisProgress) => {
      return onProgress?.({
        message: getProjectTransferOverallProgressStepLabel(projectTransferTargetAnalysisStepShares, progress.step),
        part: 'targetAnalysis',
        partFraction: getProjectTransferTargetAnalysisFraction(progress),
      })
    },
  }
}

const getTableWriteEpochFields = (targetState: ProjectTransferTargetStateDirtyTokenSnapshot | null | undefined) => {
  const tableWrites = targetState?.tableWrites

  return {
    available: tableWrites?.available === true,
    epoch: typeof tableWrites?.epoch === 'string' ? tableWrites.epoch : null,
    epochReason: typeof tableWrites?.epochReason === 'string' ? tableWrites.epochReason : null,
  }
}

const writeCommitRevalidationDecisionLogEvent = ({
  context,
  plan,
  sessionId,
}: {
  context: ProjectTransferCommitRevalidationContext
  plan: ProjectTransferImportPlanArtifact
  sessionId?: string
}) => {
  const analyzed = getTableWriteEpochFields(plan.targetState)
  const current = getTableWriteEpochFields(context.currentTargetState)

  writeRuntimeOperatorLogEvent({
    attrs: {
      analyzedEpochReason: analyzed.epochReason,
      analyzedTableWritesAvailable: analyzed.available,
      changedSurfaces: context.dirtyTokenDecision.changedSurfaces,
      currentEpochReason: current.epochReason,
      currentTableWritesAvailable: current.available,
      epochsMatched: analyzed.epoch !== null && analyzed.epoch === current.epoch,
      reason: context.dirtyTokenDecision.reason,
      sessionId: sessionId ?? null,
      status: context.dirtyTokenDecision.status,
    },
    event: 'project_transfer.commit_revalidation_decision',
    message: context.dirtyTokenDecision.eligible
      ? 'Project transfer commit skipped revalidation because tracked target tables are unchanged since analysis'
      : 'Project transfer commit runs full revalidation',
    severity: 'INFO',
  })
}

export const revalidateProjectTransferCommitPlan = async ({
  analysis,
  layout,
  nextPlanRevision,
  onProgress,
  plan,
  repositories,
  sessionId,
  ...runtimeOptions
}: ProjectTransferCommitRevalidationInput): Promise<ProjectTransferCommitRevalidationResult> => {
  const context = await getCommitRevalidationContext({plan, repositories})

  writeCommitRevalidationDecisionLogEvent({context, plan, sessionId})

  if (context.dirtyTokenDecision.eligible) {
    return getCommitRevalidationResult(plan, false)
  }

  const revalidate = async (analyzeTargetRunner?: ProjectTransferAnalyzeTargetRunner) => {
    const payloads = await readExtractedPayloads({
      ...runtimeOptions,
      layout,
      ...getRevalidationPayloadReporter(onProgress),
    })
    const freshTarget = await getProjectTransferAnalyzeTargetPlan({
      ...getRevalidationTargetAnalysisReporter(onProgress),
      packageFingerprint: analysis.packageFingerprint,
      payloads,
      runner: getCommitAnalyzeTargetRunner({analyzeTargetRunner, repositories}),
    })

    if (targetPlanRevalidationChanged({currentPlan: plan.targetPlan, freshPlan: freshTarget.targetPlan})) {
      return getCommitRevalidationResult(
        getPlanWithCommitRevalidationContext({
          context,
          plan: {...getPlanWithTargetRevalidation({freshTarget, plan}), planRevision: nextPlanRevision},
        }),
        true,
      )
    }

    await onProgress?.({message: 'Revalidating dependencies', part: 'dependencies', partFraction: 0})
    const dependencyResult = await revalidateProjectTransferResolvedDependencies({
      nextPlanRevision,
      payloads,
      plan: getResolvedDependencyPlanArtifact(plan),
      repositories: getCommitDependencyRepositories({analyzeTargetRunner, repositories}),
      request: getDependencyResolutionRequestFromPlan(plan),
    })

    if (dependencyResult.status === 'error') {
      return getCommitRevalidationResult(
        getPlanWithCommitRevalidationContext({
          context,
          plan: {
            ...getPlanWithDependencyRevalidationError({error: dependencyResult.error, plan}),
            planRevision: nextPlanRevision,
          },
        }),
        true,
      )
    }

    return dependencyResult.changed
      ? getCommitRevalidationResult(
          getPlanWithCommitRevalidationContext({
            context,
            plan: getPlanWithRevalidationBlocker({
              blocker: getCommitBlocker({
                code: 'commit_dependency_plan_stale',
                message: 'Provider, model, judgment, or human review assumptions changed since analysis',
              }),
              plan: dependencyResult.plan,
            }),
          }),
          true,
        )
      : getCommitRevalidationResult(getPlanWithCommitRevalidationContext({context, plan}), false)
  }

  return revalidate()
}

const getCommitProgress = ({
  artifacts,
  completedBytes = 0,
  completedItems,
  completedRows = 0,
  includeBytes = true,
  includeRows = true,
  message,
  now,
  overall,
  phase = 'commit',
  phaseStartedAt,
  percent,
  performanceMetrics,
  planRevision,
  stagingRevision,
  status,
  totalItems,
}: {
  artifacts: ProjectTransferCommitArtifacts
  completedBytes?: number
  completedItems?: number
  completedRows?: number
  includeBytes?: boolean
  includeRows?: boolean
  message: string
  now: Date
  overall?: ProjectTransferOverallProgress | null
  phase?: ProjectTransferProgressPayload['phase']
  phaseStartedAt?: Date
  percent?: number | null
  performanceMetrics?: ProjectTransferPerformanceMetrics
  planRevision: number
  stagingRevision?: number | null
  status: ProjectTransferProgressPayload['status']
  totalItems?: number
}): ProjectTransferProgressPayload => {
  const totalBytes = getExtractedAssetBytes(artifacts.analysis)
  const totalRows = getCommitRowCount(artifacts.plan)
  const planStagingRevision = stagingRevision ?? artifacts.plan.stagingRevision ?? null

  return {
    ...(includeBytes ? {bytesProcessed: completedBytes, bytesTotal: totalBytes, completedBytes, totalBytes} : {}),
    ...(completedItems === undefined || totalItems === undefined ? {} : {completedItems, totalItems}),
    ...(includeRows ? {completedRows, rowCountProcessed: completedRows, rowCountTotal: totalRows, totalRows} : {}),
    message,
    ...(overall === undefined || overall === null ? {} : {overall}),
    ...(percent === undefined || percent === null ? {} : {percent}),
    performanceMetrics,
    phase,
    planRevision,
    startedAt: (phaseStartedAt ?? now).toISOString(),
    ...(planStagingRevision === null ? {} : {stagingRevision: planStagingRevision}),
    status,
    updatedAt: now.toISOString(),
    warningCount: artifacts.plan.summary.warningCount,
  }
}

const writeProjectTransferCommitRuntimeEvent = ({
  error,
  ownerToken,
  progress,
  sessionId,
  state,
}: {
  error?: unknown
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
    attrs: error === undefined ? event : {...event, ...getErrorLogAttrs(error)},
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
  overall,
  ownerToken,
  repositories,
  runtimeOptions,
  session,
}: {
  artifacts: ProjectTransferCommitArtifacts
  commitId: string
  nextPlan: ProjectTransferImportPlanArtifact
  now: Date
  overall?: ProjectTransferOverallProgress | null
  ownerToken: string
  repositories: Required<Pick<ProjectTransferCommitRepositories, 'sessionRepository'>>
  runtimeOptions: RuntimePathOptions
  session: ProjectTransferSessionRecord
}) => {
  const progress = getCommitProgress({
    artifacts,
    includeBytes: false,
    includeRows: false,
    message: 'Import plan changed; review the updated plan',
    now: new Date(),
    overall,
    phase: 'revalidation',
    planRevision: nextPlan.planRevision,
    status: 'completed',
  })
  const reopened = await repositories.sessionRepository.reopenProjectTransferCommitSession({
    commitId,
    expectedPlanRevision: session.planRevision,
    now,
    ownerToken,
    planSummary: nextPlan.summary,
    progress,
    sessionId: session.id,
  })

  if (reopened !== null) {
    await writePlanArtifact({layout: artifacts.layout, plan: nextPlan, runtimeOptions})
    await writeCommitProgressArtifact({progress, runtimeOptions, sessionId: session.id})
  }

  return reopened
}

const publishCommitRevalidationProgress = ({
  artifacts,
  claimed,
  progress,
  revalidationProgress,
}: {
  artifacts: ProjectTransferCommitArtifacts
  claimed: ProjectTransferSessionRecord
  progress: ProjectTransferCommitProgressContext
  revalidationProgress: ProjectTransferRevalidationProgress
}) => {
  return progress.publish(
    getCommitProgress({
      artifacts,
      includeBytes: false,
      includeRows: false,
      message: `Commit revalidation: ${revalidationProgress.message}`,
      now: new Date(),
      overall: progress.overall.update({
        step: 'revalidation',
        stepFraction: getProjectTransferRevalidationFraction(revalidationProgress),
      }),
      phase: 'revalidation',
      planRevision: claimed.planRevision,
      status: 'running',
    }),
    {throttled: true},
  )
}

const runClaimedCommitRevalidation = async ({
  artifacts,
  claimed,
  inputRepositories,
  progress,
  repositories,
  runtimeOptions,
}: ProjectTransferClaimedCommitInput) => {
  const revalidationMeasurement = await measureProjectTransferPhase('revalidation', () => {
    return repositories.revalidate({
      ...runtimeOptions,
      analysis: artifacts.analysis,
      layout: artifacts.layout,
      nextPlanRevision: claimed.planRevision + 1,
      onProgress: (revalidationProgress) => {
        return publishCommitRevalidationProgress({artifacts, claimed, progress, revalidationProgress})
      },
      plan: artifacts.plan,
      repositories: inputRepositories,
      sessionId: claimed.id,
    })
  })
  progress.scheduler.cancelPending()
  const {changed, performanceMetrics, plan, ready} = revalidationMeasurement.value

  return {
    performanceMetrics: mergeProjectTransferPerformanceMetrics(
      getImportPerformanceMetrics(performanceMetrics),
      getProjectTransferPerformanceMetrics({
        benchmark: {revalidationOutcome: {changed, ready}, wallTimeMs: revalidationMeasurement.timing.durationMs},
        operation: 'import',
        phases: {revalidation: revalidationMeasurement.timing},
      }),
    ),
    plan,
    stale: !ready || changed,
  }
}

const revalidationMemoryReclaimMessages = {
  drainTimeout:
    'Project transfer commit skipped the DuckDB recycle after revalidation because in-flight DuckDB work did not drain',
  recycled: 'Project transfer commit recycled DuckDB because RSS stayed high after revalidation',
  released: 'Project transfer commit released revalidation memory before writes',
} as const

const getRevalidationMemoryReclaimOutcome = (
  reclaim: Awaited<ReturnType<ProjectTransferDuckdbExclusiveWorkLease['reclaimMemory']>>,
) => {
  return reclaim.recycleSkippedReason ?? (reclaim.recycled ? 'recycled' : 'released')
}

const getPlanWithCommitWriteGuardChange = ({
  error,
  nextPlanRevision,
  plan,
}: {
  error: ProjectTransferCommitTargetStateChangedError
  nextPlanRevision: number
  plan: ProjectTransferImportPlanArtifact
}): ProjectTransferImportPlanArtifact => {
  const stalePlanReasons = getProjectTransferDirtyTokenStalePlanReasons(error.decision)
  const {commitIdMaps: _commitIdMaps, ...uncommittedPlan} = plan

  return {
    ...uncommittedPlan,
    planRevision: nextPlanRevision,
    stalePlanReasons,
    summary: {...plan.summary, stalePlanReasons},
  }
}

const reclaimProjectTransferCommitRevalidationMemory = async (lease: ProjectTransferDuckdbExclusiveWorkLease) => {
  const reclaim = await lease.reclaimMemory()
  const outcome = getRevalidationMemoryReclaimOutcome(reclaim)

  writeRuntimeLogEvent({
    attrs: {
      activeMaintenance: reclaim.readiness.activeMaintenance ?? [],
      appendQueueDepth: reclaim.readiness.appendQueueDepth,
      backgroundQueueDepth: reclaim.readiness.backgroundQueueDepth,
      foregroundQueueDepth: reclaim.readiness.foregroundQueueDepth,
      maxRssBytes: reclaim.readiness.maxRssBytes ?? null,
      outcome,
      recycled: reclaim.recycled,
      rssBytes: reclaim.readiness.rssBytes ?? null,
      sessionId: lease.snapshot().sessionId,
    },
    event: 'project_transfer.commit_revalidation_memory_reclaimed',
    message: revalidationMemoryReclaimMessages[outcome],
    severity: outcome === 'released' ? 'INFO' : 'WARN',
  })

  return reclaim
}

const getRepositorySet = (repositories?: ProjectTransferCommitRepositories) => {
  return {
    getCommitId: repositories?.getCommitId ?? randomUUID,
    getOwnerToken: repositories?.getOwnerToken ?? randomUUID,
    historyRepository: repositories?.historyRepository ?? getProjectTransferHistoryRepository(),
    reclaimRevalidationMemory:
      repositories?.reclaimRevalidationMemory ?? reclaimProjectTransferCommitRevalidationMemory,
    revalidate: repositories?.revalidate ?? revalidateProjectTransferCommitPlan,
    requestReviewServingBuild: repositories?.requestReviewServingBuild ?? requestReviewServingV4Rebuild,
    runAppTableWrites: repositories?.runAppTableWrites ?? runProjectTransferCommitAppTableWrites,
    sessionRepository: repositories?.sessionRepository ?? getProjectTransferSessionRepository(),
    startBackgroundCommit: repositories?.startBackgroundCommit ?? startDetachedProjectTransferImportCommit,
  }
}

const getProjectTransferCommitOperationDatabase = (
  tx: ProjectTransferOperationTableRunner,
): ProjectTransferCommitWriterDatabase => {
  return {
    queryJson: tx.queryJson,
    run: tx.run,
    transaction: <T>(work: (writerTx: ProjectTransferOperationTableRunner) => Promise<T> | T) => {
      return Promise.resolve(work(tx))
    },
  }
}

const getCommitWriterStepProgress = ({
  artifacts,
  overallProgress,
  step,
}: {
  artifacts: ProjectTransferCommitArtifacts
  overallProgress?: ProjectTransferOverallProgressTracker<'commit'>
  step: ProjectTransferCommitWriterStepProgress
}) => {
  return getCommitProgress({
    artifacts,
    includeBytes: false,
    includeRows: false,
    message: `Writing imported project data: ${step.label} (${step.index}/${step.count})`,
    now: new Date(),
    overall: overallProgress?.update({step: 'writeTables', stepFraction: getProjectTransferCommitWriterFraction(step)}),
    phase: 'app_table_writes',
    planRevision: artifacts.plan.planRevision,
    status: 'running',
  })
}

const runProjectTransferCommitAppTableWrites = async ({
  artifacts,
  commitId,
  now,
  onProgress,
  overallProgress,
  schemaVersion,
  sessionId,
  ...runtimeOptions
}: ProjectTransferCommitAppTableWriteInput): Promise<ProjectTransferCommitAppWriteResult> => {
  const stagingLoadStartedAt = new Date()
  await onProgress?.(
    getCommitProgress({
      artifacts,
      completedItems: 0,
      completedRows: 0,
      includeBytes: false,
      message: 'Loading package payloads',
      now: stagingLoadStartedAt,
      overall: overallProgress?.update({step: 'loadPayloads', stepFraction: 0}),
      percent: 0,
      phase: 'staging_load',
      phaseStartedAt: stagingLoadStartedAt,
      planRevision: artifacts.plan.planRevision,
      status: 'running',
      totalItems: projectTransferPayloadKeys.length,
    }),
  )
  const stagingLoad = await measureProjectTransferPhase('stagingLoad', () => {
    return readExtractedPayloads({
      ...runtimeOptions,
      artifacts,
      layout: artifacts.layout,
      onProgress,
      overallProgress,
      phaseStartedAt: stagingLoadStartedAt,
      retainCompactJudgments: true,
    })
  })
  const payloads = stagingLoad.value
  const assetPromotionStartedAt = new Date()
  const assetPromotionItemCount = artifacts.plan.targetPlan.assetPromotionPlan.length
  const assetPromotionBytes = getExtractedAssetBytes(artifacts.analysis)
  await onProgress?.(
    getCommitProgress({
      artifacts,
      completedBytes: 0,
      completedItems: 0,
      includeBytes: assetPromotionBytes > 0,
      includeRows: false,
      message: assetPromotionItemCount === 0 ? 'No package assets to promote' : 'Asset promotion running',
      now: assetPromotionStartedAt,
      overall: overallProgress?.update({step: 'prepare', stepFraction: 0}),
      percent: assetPromotionItemCount === 0 ? 100 : 0,
      phase: 'asset_promotion',
      phaseStartedAt: assetPromotionStartedAt,
      planRevision: artifacts.plan.planRevision,
      status: assetPromotionItemCount === 0 ? 'completed' : 'running',
      totalItems: assetPromotionItemCount,
    }),
  )
  const assetPromotion = await measureProjectTransferPhase('assetPromotion', () => {
    return promoteProjectTransferCommitAssets({
      ...runtimeOptions,
      articles: payloads.articles ?? [],
      layout: artifacts.layout,
      now,
      onProgress: (progress) => {
        return onProgress?.(
          getCommitProgress({
            artifacts,
            completedBytes: progress.completedBytes,
            completedItems: progress.completedItems,
            includeBytes: progress.totalBytes > 0,
            includeRows: false,
            message:
              progress.currentPackagePath === null
                ? 'Asset promotion running'
                : `Promoted asset ${progress.currentPackagePath}`,
            now: new Date(),
            overall: overallProgress?.update({
              step: 'prepare',
              stepFraction: progress.totalItems > 0 ? progress.completedItems / progress.totalItems / 2 : 0.5,
            }),
            percent: getPercentFromCounts({completed: progress.completedItems, total: progress.totalItems}),
            phase: 'asset_promotion',
            phaseStartedAt: assetPromotionStartedAt,
            planRevision: artifacts.plan.planRevision,
            status: progress.completedItems === progress.totalItems ? 'completed' : 'running',
            totalItems: progress.totalItems,
          }),
          {throttled: progress.completedItems > 0 && progress.completedItems < progress.totalItems},
        )
      },
      plan: artifacts.plan,
      sessionId,
    })
  })

  try {
    await onProgress?.(
      getCommitProgress({
        artifacts,
        completedBytes: getExtractedAssetBytes(artifacts.analysis),
        completedItems: assetPromotionItemCount,
        includeRows: false,
        message: 'Asset promotion completed',
        now: new Date(),
        overall: overallProgress?.update({step: 'prepare', stepFraction: 0.5}),
        phase: 'asset_promotion',
        phaseStartedAt: assetPromotionStartedAt,
        percent: 100,
        planRevision: artifacts.plan.planRevision,
        status: 'completed',
        totalItems: assetPromotionItemCount,
      }),
    )
    await onProgress?.(
      getCommitProgress({
        artifacts,
        includeBytes: false,
        message: 'Writing imported project data',
        now: new Date(),
        overall: overallProgress?.update({step: 'prepare', stepFraction: 0.5}),
        phase: 'app_table_writes',
        planRevision: artifacts.plan.planRevision,
        status: 'running',
      }),
    )

    const planWithCommitIdMaps = getProjectTransferPlanWithCommitIdMaps({
      commitId,
      now,
      payloads,
      plan: artifacts.plan,
      promotion: assetPromotion.value,
    })

    await writePlanArtifact({layout: artifacts.layout, plan: planWithCommitIdMaps, runtimeOptions})

    const database = getAppDatabaseService()
    const appTableWrites = await measureProjectTransferPhase(
      'appTableWrites',
      (): Promise<ProjectTransferCommitAppWriteResult> => {
        return withProjectTransferOperationTables({
          ...runtimeOptions,
          layout: artifacts.layout,
          operationId: `commit_${commitId}`,
          runner: database,
          workloadContext: projectTransferCommitTransactionWorkloadContext,
          work: ({tables}) => {
            return database.transaction((tx): Promise<ProjectTransferCommitAppWriteResult> => {
              return writeProjectTransferCommitAppTables({
                ...runtimeOptions,
                commitId,
                database: getProjectTransferCommitOperationDatabase(tx),
                now,
                onStep: (step) => {
                  return onProgress?.(getCommitWriterStepProgress({artifacts, overallProgress, step}), {
                    persist: 'artifact',
                    throttled: true,
                  })
                },
                operationTables: tables,
                payloads,
                plan: planWithCommitIdMaps,
                promotion: assetPromotion.value,
                schemaVersion,
                sessionId,
              })
            }, projectTransferCommitTransactionWorkloadContext)
          },
        })
      },
    )
    await onProgress?.(
      getCommitProgress({
        artifacts,
        completedRows: getCommitRowCount(artifacts.plan),
        includeBytes: false,
        message: 'Finishing imported project data',
        now: new Date(),
        overall: overallProgress?.update({step: 'finish', stepFraction: 0}),
        phase: 'app_table_writes',
        planRevision: artifacts.plan.planRevision,
        status: 'running',
      }),
    )
    const phaseMetrics = getProjectTransferPerformanceMetrics({
      benchmark: {
        correctnessChecks: {
          assetPromotionReadCount: assetPromotion.value.metrics?.assetReadCount ?? projectTransferMetricUnavailable,
          promotedAssetRereadCount:
            assetPromotion.value.metrics?.promotedAssetRereadCount ?? projectTransferMetricUnavailable,
        },
        finalAssetBytes: artifacts.analysis.assetSummary.actualByteLength,
        packageFingerprint: artifacts.analysis.packageFingerprint ?? undefined,
        schemaVersion,
      },
      bytes: {
        assetBytes: artifacts.analysis.assetSummary.actualByteLength,
        assetPromotionBytes: assetPromotion.value.metrics?.assetByteLength,
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
    await (appTableWrites.value.commitIdMaps === undefined
      ? undefined
      : writePlanArtifact({
          layout: artifacts.layout,
          plan: {...planWithCommitIdMaps, commitIdMaps: appTableWrites.value.commitIdMaps},
          runtimeOptions,
        }).catch(() => {
          return undefined
        }))

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

type ProjectTransferClaimedCommitInput = {
  heartbeatIntervalMs?: number
  artifacts: ProjectTransferCommitArtifacts
  claimed: ProjectTransferSessionRecord
  commitId: string
  inputRepositories?: ProjectTransferCommitRepositories
  now: Date
  ownerToken: string
  progress: ProjectTransferCommitProgressContext
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
  sessionId: string
}

type ProjectTransferClaimedCommitRevalidation = Awaited<ReturnType<typeof runClaimedCommitRevalidation>>

const requestPostImportReviewServingBuild = ({
  completion,
  repositories,
}: {
  completion: ProjectTransferImportCompletionPayload
  repositories: ProjectTransferCommitRepositorySet
}) => {
  return repositories.requestReviewServingBuild({
    priority: postImportReviewServingBuildPriority,
    projectId: completion.projectId,
    reason: 'missingReviewServingSnapshot',
  })
}

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

const getCommitProgressContext = ({
  initialProgress,
  overall,
  ownerToken,
  repositories,
  runtimeOptions,
  sessionId,
  throttleMs,
}: {
  initialProgress: ProjectTransferProgressPayload
  overall: ProjectTransferOverallProgressTracker<'commit'>
  ownerToken: string
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
  sessionId: string
  throttleMs?: number
}): ProjectTransferCommitProgressContext => {
  const scheduler = createProjectTransferProgressPublisher({
    initialProgress,
    throttleMs,
    writeArtifact: async (progress) => {
      updateActiveDuckdbExclusiveWorkProgress(progress)
      await writeCommitProgressArtifact({progress, runtimeOptions, sessionId})
    },
    writeSession: async (progress) => {
      const updated = await updateClaimedCommitProgress({ownerToken, progress, repositories, sessionId})
      if (updated === null) throw new Error('Project transfer import commit ownership was lost while updating progress')
    },
  })
  const publishSessionProgress = async (progress: ProjectTransferProgressPayload) => {
    await scheduler.publish(progress, {persist: 'artifact'})
    await scheduler.flush()
    return updateClaimedCommitProgress({
      ownerToken,
      progress: scheduler.getLastWritten() ?? progress,
      repositories,
      sessionId,
    })
  }

  return {
    getActiveProgress: () => {
      return scheduler.getLastWritten() ?? initialProgress
    },
    overall,
    publish: scheduler.publish,
    publishSessionProgress,
    scheduler,
  }
}

const refreshClaimedCommitHeartbeat = async ({
  ownerToken,
  repositories,
  sessionId,
}: {
  ownerToken: string
  repositories: ProjectTransferCommitRepositorySet
  sessionId: string
}) => {
  const heartbeat = await repositories.sessionRepository.transitionProjectTransferSessionState({
    expectedOwnerToken: ownerToken,
    expectedState: 'committing',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'committing',
    sessionId,
  })
  if (heartbeat === null) throw new Error(`Project transfer commit session ownership was lost: ${sessionId}`)
}

const runClaimedCommitHeartbeatOperation = async <TValue>({
  heartbeatIntervalMs = commitWorkerHeartbeatIntervalMs,
  operation,
  ownerToken,
  repositories,
  scheduler,
  sessionId,
}: {
  heartbeatIntervalMs?: number
  operation: () => Promise<TValue>
  ownerToken: string
  repositories: ProjectTransferCommitRepositorySet
  scheduler: ReturnType<typeof createProjectTransferProgressPublisher>
  sessionId: string
}) => {
  const state = {
    artifact: null as Promise<void> | null,
    lease: null as Promise<void> | null,
    error: null as {cause: unknown} | null,
  }
  const recordFailure = (cause: unknown) => {
    state.error ??= {cause}
    logProjectTransferCommitHeartbeatError(sessionId, cause)
  }
  const interval = setInterval(() => {
    state.artifact ??= scheduler
      .heartbeat()
      .catch(recordFailure)
      .finally(() => {
        state.artifact = null
      })
    state.lease ??= refreshClaimedCommitHeartbeat({ownerToken, repositories, sessionId})
      .catch(recordFailure)
      .finally(() => {
        state.lease = null
      })
  }, heartbeatIntervalMs)

  const result = await operation().finally(async () => {
    clearInterval(interval)
    await Promise.all([state.artifact, state.lease])
  })
  if (state.error !== null) throw state.error.cause
  return result
}

const failClaimedCommit = async ({
  artifacts,
  error,
  ownerToken,
  progressContext,
  repositories,
  runtimeOptions,
  sessionId,
}: {
  artifacts: ProjectTransferCommitArtifacts
  error: unknown
  ownerToken: string
  progressContext?: ProjectTransferCommitProgressContext
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
  sessionId: string
}) => {
  await settleCompletionSideEffect(progressContext?.scheduler.close() ?? Promise.resolve())
  const now = new Date()
  const progress = getCommitProgress({
    artifacts,
    completedBytes: getExtractedAssetBytes(artifacts.analysis),
    message: retryableCommitFailureMessage,
    now,
    overall: progressContext?.overall.getCurrent(),
    percent: 100,
    planRevision: artifacts.plan.planRevision,
    status: 'failed',
  })
  await settleCompletionSideEffect(writeCommitProgressArtifact({progress, runtimeOptions, sessionId}))
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

  writeProjectTransferCommitRuntimeEvent({error, ownerToken, progress, sessionId, state: failed?.state ?? 'failed'})

  return failed
}

const getCommitErrorResult = (error: unknown): ProjectTransferCommitResult => {
  return {error: error instanceof Error ? error.message : String(error), status: 'error', statusCode: 500}
}

const failClaimedPostClaimCommit = async ({
  artifacts,
  error,
  ownerToken,
  progressContext,
  repositories,
  runtimeOptions,
  sessionId,
  statusCode = 500,
}: {
  artifacts: ProjectTransferCommitArtifacts
  error: unknown
  ownerToken: string
  progressContext?: ProjectTransferCommitProgressContext
  repositories: ProjectTransferCommitRepositorySet
  runtimeOptions: RuntimePathOptions
  sessionId: string
  statusCode?: number
}): Promise<ProjectTransferCommitResult> => {
  await settleCompletionSideEffect(
    failClaimedCommit({artifacts, error, ownerToken, progressContext, repositories, runtimeOptions, sessionId}),
  )

  return {error: error instanceof Error ? error.message : String(error), status: 'error', statusCode}
}

const getClaimedCommitRevalidationProgress = ({
  artifacts,
  claimed,
  message,
  overall,
}: {
  artifacts: ProjectTransferCommitArtifacts
  claimed: ProjectTransferSessionRecord
  message: string
  overall: ProjectTransferOverallProgress
}) => {
  return getCommitProgress({
    artifacts,
    includeBytes: false,
    includeRows: false,
    message,
    now: new Date(),
    overall,
    phase: 'revalidation',
    planRevision: claimed.planRevision,
    status: 'running',
  })
}

const writeRevalidatedClaimedCommit = async ({
  input,
  lease,
  revalidation,
}: {
  input: ProjectTransferClaimedCommitInput
  lease: ProjectTransferDuckdbExclusiveWorkLease
  revalidation: ProjectTransferClaimedCommitRevalidation
}) => {
  const artifacts = {...input.artifacts, plan: revalidation.plan}

  await input.repositories.reclaimRevalidationMemory(lease)

  const writeOutcome = await input.repositories
    .runAppTableWrites({
      artifacts,
      commitId: input.commitId,
      now: input.now,
      onProgress: input.progress.publish,
      overallProgress: input.progress.overall,
      schemaVersion: getAnalysisSchemaVersion(artifacts.analysis),
      ...input.runtimeOptions,
      sessionId: input.sessionId,
    })
    .then(
      (writeResult) => {
        return {status: 'written' as const, writeResult}
      },
      (error: unknown) => {
        return isProjectTransferCommitTargetStateChangedError(error)
          ? {error, status: 'targetStateChanged' as const}
          : Promise.reject(error)
      },
    )

  return writeOutcome.status === 'written'
    ? {
        artifacts,
        performanceMetrics: revalidation.performanceMetrics,
        status: 'written' as const,
        writeResult: writeOutcome.writeResult,
      }
    : {
        plan: getPlanWithCommitWriteGuardChange({
          error: writeOutcome.error,
          nextPlanRevision: input.claimed.planRevision + 1,
          plan: revalidation.plan,
        }),
        status: 'stale' as const,
      }
}

const runClaimedCommitExclusiveWork = (input: ProjectTransferClaimedCommitInput) => {
  return runWithDuckdbExclusiveWork(
    {
      estimatedRows: getCommitRowCount(input.artifacts.plan),
      kind: 'project_transfer_import',
      message: 'Commit revalidation and app-table writes requested',
      ownerToken: input.ownerToken,
      phase: 'commit',
      sessionId: input.sessionId,
    },
    async (lease) => {
      await input.progress.publish(
        getClaimedCommitRevalidationProgress({
          artifacts: input.artifacts,
          claimed: input.claimed,
          message: 'Commit revalidation running',
          overall: input.progress.overall.update({step: 'revalidation', stepFraction: 0}),
        }),
      )

      await input.progress.scheduler.flush()
      const revalidation = await runClaimedCommitRevalidation(input)
      await input.progress.scheduler.flush()

      return revalidation.stale
        ? {plan: revalidation.plan, status: 'stale' as const}
        : writeRevalidatedClaimedCommit({input, lease, revalidation})
    },
  )
}

const reopenClaimedCommitStalePlan = async ({
  input,
  plan,
}: {
  input: ProjectTransferClaimedCommitInput
  plan: ProjectTransferImportPlanArtifact
}): Promise<ProjectTransferCommitResult> => {
  await input.progress.scheduler.close()
  const reopened = await persistPostClaimStalePlan({
    artifacts: input.artifacts,
    commitId: input.commitId,
    nextPlan: plan,
    now: input.now,
    overall: input.progress.overall.getCurrent(),
    ownerToken: input.ownerToken,
    repositories: input.repositories,
    runtimeOptions: input.runtimeOptions,
    session: input.claimed,
  })

  return reopened === null
    ? failClaimedPostClaimCommit({
        artifacts: input.artifacts,
        error: 'Project transfer commit could not reopen claimed stale plan',
        ownerToken: input.ownerToken,
        progressContext: input.progress,
        repositories: input.repositories,
        runtimeOptions: input.runtimeOptions,
        sessionId: input.sessionId,
        statusCode: 409,
      })
    : {plan, session: reopened, status: 'stale', statusCode: 200}
}

const runClaimedProjectTransferImportCommit = async (
  input: ProjectTransferClaimedCommitInput,
): Promise<ProjectTransferCommitResult> => {
  const {claimed, ownerToken, progress, repositories, runtimeOptions, sessionId} = input

  try {
    const waitingProgress = getClaimedCommitRevalidationProgress({
      artifacts: input.artifacts,
      claimed,
      message: 'Waiting for DuckDB maintenance work to pause',
      overall: progress.overall.update({step: 'waitForDuckdb', stepFraction: null}),
    })
    const progressed = await progress.publishSessionProgress(waitingProgress)

    if (progressed === null) {
      await progress.scheduler.close()
      return {
        error: 'Project transfer import commit ownership was lost before revalidation',
        status: 'error',
        statusCode: 409,
      }
    }

    const outcome = await runClaimedCommitHeartbeatOperation({
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      operation: () => {
        return runClaimedCommitExclusiveWork(input)
      },
      ownerToken,
      repositories,
      scheduler: progress.scheduler,
      sessionId,
    })

    if (outcome.status === 'stale') {
      return await reopenClaimedCommitStalePlan({input, plan: outcome.plan})
    }

    const {artifacts, performanceMetrics, writeResult} = outcome
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
      overall: progress.overall.complete(),
      percent: 100,
      performanceMetrics: completedPerformanceMetrics,
      planRevision: claimed.planRevision,
      status: 'completed',
    })

    await progress.publishSessionProgress(completedProgress)
    await progress.scheduler.close()
    const persistedCompletedProgress = progress.getActiveProgress()

    const completedSession = await settleCompletionSideEffect(
      repositories.sessionRepository.persistProjectTransferSessionCompletion({
        completionPayload: writeResult.completion,
        progress: persistedCompletedProgress,
        expectedPlanRevision: claimed.planRevision,
        now: new Date(persistedCompletedProgress.updatedAt ?? completionNow),
        ownerToken,
        sessionId,
      }),
    )
    await settleCompletionSideEffect(
      writeCompletionArtifact({completion: writeResult.completion, layout: artifacts.layout, runtimeOptions}),
    )
    await settleCompletionSideEffect(
      requestPostImportReviewServingBuild({completion: writeResult.completion, repositories}),
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
    await settleCompletionSideEffect(
      failClaimedCommit({
        artifacts: input.artifacts,
        error,
        ownerToken,
        progressContext: progress,
        repositories,
        runtimeOptions,
        sessionId,
      }),
    )
    return getCommitErrorResult(error)
  }
}

export const commitProjectTransferImportSession = async ({
  heartbeatIntervalMs,
  progressThrottleMs,
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

  const isFailedCommitRetry = isProjectTransferFailedCommitRetryCandidate(toProjectTransferSessionResponse(current))
  let artifacts: ProjectTransferCommitArtifacts

  try {
    artifacts = await loadProjectTransferCommitArtifacts({...runtimeOptions, session: current, sessionId})
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)

    return {error: `Project transfer import artifacts are unavailable: ${detail}`, status: 'error', statusCode: 409}
  }

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

  if (executionMode !== 'background' && !isFailedCommitRetry) {
    const preClaimRevalidationMeasurement = await measureProjectTransferPhase('revalidation', () => {
      return repositories.revalidate({
        ...runtimeOptions,
        analysis: artifacts.analysis,
        layout: artifacts.layout,
        nextPlanRevision: current.planRevision + 1,
        plan: artifacts.plan,
        repositories: inputRepositories,
        sessionId: current.id,
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
  const overallProgress = createProjectTransferOverallProgressTracker('commit')
  const claimProgress = getCommitProgress({
    artifacts,
    includeBytes: false,
    includeRows: false,
    message: 'Commit revalidation running',
    now,
    overall: overallProgress.update({step: 'waitForDuckdb', stepFraction: null}),
    phase: 'revalidation',
    planRevision: revision.planRevision,
    status: 'running',
  })
  const claimed = await repositories.sessionRepository.transitionProjectTransferSessionState({
    commitId,
    ...(isFailedCommitRetry ? {completionPayload: null, error: null} : {}),
    expectedOwnerToken: null,
    expectedPlanRevision: revision.planRevision,
    expectedStagingRevision,
    expectedState: isFailedCommitRetry ? 'failed' : 'ready_to_commit',
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
  await writeCommitProgressArtifact({progress: claimProgress, runtimeOptions, sessionId})

  const claimedCommitInput: ProjectTransferClaimedCommitInput = {
    heartbeatIntervalMs,
    artifacts,
    claimed,
    commitId,
    inputRepositories,
    now,
    ownerToken,
    progress: getCommitProgressContext({
      throttleMs: progressThrottleMs,
      initialProgress: claimProgress,
      overall: overallProgress,
      ownerToken,
      repositories,
      runtimeOptions,
      sessionId,
    }),
    repositories,
    runtimeOptions,
    sessionId,
  }

  if (executionMode === 'background') {
    repositories.startBackgroundCommit(async () => {
      await runWithProjectTransferBackgroundActivity(async () => {
        await runClaimedProjectTransferImportCommit(claimedCommitInput)
      })
    })

    return {commitId, executionMode, session: claimed, status: 'claimed', statusCode: 202}
  }

  return runClaimedProjectTransferImportCommit(claimedCommitInput)
}

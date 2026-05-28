import {randomUUID} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'

import type {ProjectTransferHistoryRecord, ProjectTransferSessionRecord} from '../../../db/schemaTypes.ts'
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
  parseProjectTransferCompletionPayload,
  parseProjectTransferPlanSummary,
  type ProjectTransferCompletionPayload,
  type ProjectTransferPlanBlocker,
  type ProjectTransferPlanSummary,
  type ProjectTransferProgressPayload,
  toProjectTransferSessionResponse,
  validateProjectTransferPlanReadyToCommit,
} from './projectTransferContracts.ts'
import {
  type ProjectTransferDependencyResolutionRepositories,
  type ProjectTransferDependencyResolutionRequest,
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
import {projectTransferPayloadKeys, projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout, type ProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferSessionRepository} from './projectTransferSessionRepository.ts'

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
  sessionRepository?: Pick<
    ReturnType<typeof getProjectTransferSessionRepository>,
    | 'getProjectTransferSession'
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
  plan: ProjectTransferImportPlanArtifact
  ready: boolean
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
  | {commitId: string; session: ProjectTransferSessionRecord; status: 'claimed'; statusCode: 202}
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
  sessionId,
  ...runtimeOptions
}: RuntimePathOptions & {sessionId: string}): Promise<ProjectTransferCommitArtifacts> => {
  const layout = getProjectTransferImportTempLayout(sessionId)
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

  return {ok: true, planRevision: planRevision ?? (expectedPlanRevision as number)}
}

const getCompletedImportHistoryCompletion = (history: ProjectTransferHistoryRecord | null) => {
  return history ? parseProjectTransferCompletionPayload(history.completionPayloadJson, 'import') : null
}

const getSessionCompletion = (session: ProjectTransferSessionRecord) => {
  return parseProjectTransferCompletionPayload(session.completionPayloadJson, session.direction)
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
  analysis,
  plan,
  requestPlanRevision,
  session,
}: {
  analysis: ProjectTransferImportAnalysisArtifact
  plan: ProjectTransferImportPlanArtifact
  requestPlanRevision: number
  session: ProjectTransferSessionRecord
}) => {
  const sessionPlanSummary = parseProjectTransferPlanSummary(session.planSummaryJson)

  if (requestPlanRevision !== session.planRevision) {
    return {error: 'Project transfer commit request planRevision is stale', ok: false as const}
  }

  if (plan.planRevision !== session.planRevision) {
    return {error: 'Project transfer commit plan artifact revision is stale', ok: false as const}
  }

  if (analysis.planRevision !== plan.planRevision) {
    return {error: 'Project transfer commit analysis artifact revision is stale', ok: false as const}
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
    plan,
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

const getCommitProgress = ({now, planRevision}: {now: Date; planRevision: number}): ProjectTransferProgressPayload => {
  return {
    message: 'Commit claimed',
    percent: 0,
    phase: 'commit',
    planRevision,
    startedAt: now.toISOString(),
    status: 'running',
    updatedAt: now.toISOString(),
  }
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
  await writePlanArtifact({layout: artifacts.layout, plan: nextPlan, runtimeOptions})

  return repositories.sessionRepository.updateProjectTransferSessionPlanRevision({
    expectedOwnerToken: null,
    expectedPlanRevision: artifacts.plan.planRevision,
    nextState: 'awaiting_resolution',
    now,
    planSummary: nextPlan.summary,
    sessionId,
  })
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
  await writePlanArtifact({layout: artifacts.layout, plan: nextPlan, runtimeOptions})

  return repositories.sessionRepository.reopenProjectTransferCommitSession({
    commitId,
    expectedPlanRevision: session.planRevision,
    now,
    ownerToken,
    planSummary: nextPlan.summary,
    sessionId: session.id,
  })
}

const getRepositorySet = (repositories?: ProjectTransferCommitRepositories) => {
  return {
    getCommitId: repositories?.getCommitId ?? randomUUID,
    getOwnerToken: repositories?.getOwnerToken ?? randomUUID,
    historyRepository: repositories?.historyRepository ?? getProjectTransferHistoryRepository(),
    revalidate: repositories?.revalidate ?? revalidateProjectTransferCommitPlan,
    sessionRepository: repositories?.sessionRepository ?? getProjectTransferSessionRepository(),
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

  if (current.state === 'completed') {
    return getCompletedRetryResult({historyRepository: repositories.historyRepository, session: current})
  }

  if (current.state === 'committing') {
    return {session: current, status: 'in_flight', statusCode: 202}
  }

  const invalidSession = getInvalidSessionResult({now, session: current})

  if (invalidSession !== null) {
    return invalidSession
  }

  const artifacts = await loadProjectTransferCommitArtifacts({...runtimeOptions, sessionId})
  const artifactConsistency = assertArtifactConsistency({
    analysis: artifacts.analysis,
    plan: artifacts.plan,
    requestPlanRevision: revision.planRevision,
    session: current,
  })

  if (!artifactConsistency.ok) {
    return {error: artifactConsistency.error, status: 'error', statusCode: 409}
  }

  const preClaimRevalidation = await repositories.revalidate({
    ...runtimeOptions,
    analysis: artifacts.analysis,
    layout: artifacts.layout,
    nextPlanRevision: current.planRevision + 1,
    plan: artifacts.plan,
    repositories: inputRepositories,
  })

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

  const commitId = repositories.getCommitId()
  const ownerToken = repositories.getOwnerToken()
  const claimed = await repositories.sessionRepository.transitionProjectTransferSessionState({
    commitId,
    expectedOwnerToken: null,
    expectedPlanRevision: revision.planRevision,
    expectedState: 'ready_to_commit',
    nextOwnerLeaseMs: 60_000,
    nextOwnerToken: ownerToken,
    nextState: 'committing',
    now,
    progress: getCommitProgress({now, planRevision: revision.planRevision}),
    sessionId,
  })

  if (claimed === null) {
    const refreshed = await repositories.sessionRepository.getProjectTransferSession({sessionId})

    return refreshed?.state === 'committing'
      ? {session: refreshed, status: 'in_flight', statusCode: 202}
      : {error: 'Project transfer import commit could not be claimed', status: 'error', statusCode: 409}
  }

  const postClaimRevalidation = await repositories.revalidate({
    ...runtimeOptions,
    analysis: artifacts.analysis,
    layout: artifacts.layout,
    nextPlanRevision: claimed.planRevision + 1,
    plan: artifacts.plan,
    repositories: inputRepositories,
  })

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
      ? {error: 'Project transfer commit could not reopen claimed stale plan', status: 'error', statusCode: 409}
      : {plan: postClaimRevalidation.plan, session: reopened, status: 'stale', statusCode: 200}
  }

  return {commitId, session: claimed, status: 'claimed', statusCode: 202}
}

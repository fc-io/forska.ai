import {readFile, rm} from 'node:fs/promises'

import type {
  ProjectTransferDirection,
  ProjectTransferHistoryRecord,
  ProjectTransferSessionState,
} from '../../../db/schemaTypes.ts'
import {canCurrentServerOwnDuckdb} from '../../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../appQueryHelpers.ts'
import type {ProjectTransferAssetPromotionMetadata} from './projectTransferContracts.ts'
import {getProjectTransferHistoryRepository} from './projectTransferHistoryRepository.ts'
import {
  resolveProjectTransferPromotionWritablePath,
  resolveProjectTransferTempWritablePath,
  validateProjectTransferPromotionWritablePath,
} from './projectTransferPaths.ts'
import {
  getProjectTransferExportTempLayout,
  getProjectTransferImportTempLayout,
  isProjectTransferTerminalState,
  parseProjectTransferCompletionPayload,
  projectTransferTerminalStates,
} from './projectTransferSession.ts'

type ProjectTransferSessionRecoveryRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction?: <T>(operation: (runner: ProjectTransferSessionRecoveryRunner) => Promise<T>) => Promise<T>
}

type ProjectTransferSessionRecoveryRuntimeOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type ProjectTransferSessionRecoveryParams = ProjectTransferSessionRecoveryRuntimeOptions & {
  batchSize?: number
  isActiveWriter?: () => boolean
  now?: Date
  ownerToken?: string
  runner?: ProjectTransferSessionRecoveryRunner
}

type ProjectTransferRecoveryCandidate = {
  direction: ProjectTransferDirection
  id: string
  state: ProjectTransferSessionState
}

type ProjectTransferRecoveryCleanupPlan = ProjectTransferRecoveryCandidate & {
  deletePromotedAssets: boolean
  deleteTempArtifacts: boolean
  recoveredFromHistory: boolean
  transitionedToExpired: boolean
}

type ProjectTransferPromotedAssetCleanupResult = {deletedPromotedAssetCount: number; skippedPromotedAssetCount: number}

type ProjectTransferSessionRecoveryResult = ProjectTransferPromotedAssetCleanupResult & {
  cleanupTempArtifactCount: number
  expiredSessionCount: number
  recoveredCompletionCount: number
  scannedSessionCount: number
  skippedActiveWriterCheck: boolean
}

type ProjectTransferCleanupCounts = Pick<
  ProjectTransferSessionRecoveryResult,
  'cleanupTempArtifactCount' | 'deletedPromotedAssetCount' | 'skippedPromotedAssetCount'
>

type ProjectTransferCleanupFailure = {error: unknown; plan: ProjectTransferRecoveryCleanupPlan}

type ProjectTransferCleanupResult = ProjectTransferCleanupCounts & {
  failedPlans: ProjectTransferCleanupFailure[]
  successfulPlans: ProjectTransferRecoveryCleanupPlan[]
}

const defaultRecoveryBatchSize = 50
const maxRecoveryBatchSize = 500
const terminalStateListSql = getQuotedStringList([...projectTransferTerminalStates]).join(', ')

const emptyRecoveryResult = (skippedActiveWriterCheck: boolean): ProjectTransferSessionRecoveryResult => {
  return {
    cleanupTempArtifactCount: 0,
    deletedPromotedAssetCount: 0,
    expiredSessionCount: 0,
    recoveredCompletionCount: 0,
    scannedSessionCount: 0,
    skippedActiveWriterCheck,
    skippedPromotedAssetCount: 0,
  }
}

const getRecoveryBatchSize = (batchSize: number | undefined) => {
  const normalized = Math.floor(batchSize ?? defaultRecoveryBatchSize)

  return Math.max(1, Math.min(maxRecoveryBatchSize, normalized))
}

const getRunner = (runner?: ProjectTransferSessionRecoveryRunner) => {
  return runner ?? getAppDatabaseService()
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getRecoveryOwnerToken = (ownerToken: string | undefined) => {
  return typeof ownerToken === 'string' && ownerToken.trim().length > 0
    ? ownerToken
    : `project-transfer-recovery-${process.pid}`
}

const getStaleProjectTransferSessions = async ({
  batchSize,
  now,
  runner,
}: {
  batchSize: number
  now: Date
  runner: ProjectTransferSessionRecoveryRunner
}) => {
  return runner.queryJson<ProjectTransferRecoveryCandidate>(`
    SELECT
      direction,
      id,
      state
    FROM app.project_transfer_session
    WHERE expires_at <= ${getTimestampLiteral(now)}
      AND (state NOT IN (${terminalStateListSql}) OR terminal_cleanup_at IS NULL)
    ORDER BY
      CASE WHEN state IN (${terminalStateListSql}) THEN 1 ELSE 0 END ASC,
      expires_at ASC,
      updated_at ASC,
      id ASC
    LIMIT ${batchSize}
  `)
}

const transitionImportSessionToCompletedFromHistory = async ({
  history,
  now,
  runner,
  session,
}: {
  history: ProjectTransferHistoryRecord
  now: Date
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
}) => {
  const completionPayload = parseProjectTransferCompletionPayload(history.completionPayloadJson)

  if (completionPayload?.status !== 'completed') {
    return null
  }

  const [row] = await runner.queryJson<ProjectTransferRecoveryCandidate>(`
    UPDATE app.project_transfer_session
    SET
      state = 'completed',
      commit_id = ${getSqlLiteral(history.commitId)},
      package_fingerprint = ${getSqlLiteral(history.packageFingerprint)},
      owner_token = NULL,
      completion_payload_json = ${getJsonLiteral(completionPayload)},
      error_json = NULL,
      updated_at = ${getTimestampLiteral(now)}
    WHERE id = ${getSqlLiteral(session.id)}
      AND direction = 'import'
      AND state = ${getSqlLiteral(session.state)}
      AND expires_at <= ${getTimestampLiteral(now)}
    RETURNING direction, id, state
  `)

  return row ?? null
}

const transitionSessionToExpired = async ({
  now,
  ownerToken,
  runner,
  session,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
}) => {
  const [row] = await runner.queryJson<ProjectTransferRecoveryCandidate>(`
    UPDATE app.project_transfer_session
    SET
      state = 'expired',
      owner_token = ${getSqlLiteral(ownerToken)},
      error_json = ${getJsonLiteral({reason: 'project_transfer_session_recovery_expired'})},
      updated_at = ${getTimestampLiteral(now)}
    WHERE id = ${getSqlLiteral(session.id)}
      AND state = ${getSqlLiteral(session.state)}
      AND expires_at <= ${getTimestampLiteral(now)}
    RETURNING direction, id, state
  `)

  return row ?? null
}

const getCompletedImportHistory = async ({
  runner,
  session,
}: {
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
}) => {
  return session.direction === 'import'
    ? getProjectTransferHistoryRepository().getCompletedImportHistoryBySessionId({runner, sessionId: session.id})
    : null
}

const getCleanupPlanForSession = async ({
  now,
  ownerToken,
  runner,
  session,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
}): Promise<ProjectTransferRecoveryCleanupPlan | null> => {
  const history = await getCompletedImportHistory({runner, session})
  const shouldRecoverFromHistory = history !== null && session.state !== 'completed'

  if (shouldRecoverFromHistory) {
    const completedSession = await transitionImportSessionToCompletedFromHistory({history, now, runner, session})

    return completedSession === null
      ? null
      : {
          ...session,
          deletePromotedAssets: false,
          deleteTempArtifacts: true,
          recoveredFromHistory: true,
          transitionedToExpired: false,
        }
  }

  if (isProjectTransferTerminalState(session.state)) {
    return {
      ...session,
      deletePromotedAssets: session.direction === 'import' && session.state !== 'completed' && history === null,
      deleteTempArtifacts: true,
      recoveredFromHistory: false,
      transitionedToExpired: false,
    }
  }

  const expiredSession = await transitionSessionToExpired({now, ownerToken, runner, session})

  return expiredSession === null
    ? null
    : {
        ...session,
        deletePromotedAssets: session.direction === 'import' && history === null,
        deleteTempArtifacts: true,
        recoveredFromHistory: false,
        transitionedToExpired: true,
      }
}

const getCleanupPlans = async ({
  now,
  ownerToken,
  runner,
  sessions,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  sessions: ProjectTransferRecoveryCandidate[]
}) => {
  return sessions.reduce<Promise<ProjectTransferRecoveryCleanupPlan[]>>(async (promise, session) => {
    const plans = await promise
    const plan = await getCleanupPlanForSession({now, ownerToken, runner, session})

    return plan === null ? plans : [...plans, plan]
  }, Promise.resolve([]))
}

const getTempRootPath = (plan: ProjectTransferRecoveryCleanupPlan) => {
  return plan.direction === 'import'
    ? getProjectTransferImportTempLayout(plan.id).rootPath
    : getProjectTransferExportTempLayout(plan.id).rootPath
}

const getPromotionManifestPath = (plan: ProjectTransferRecoveryCleanupPlan) => {
  return getProjectTransferImportTempLayout(plan.id).promotionManifestPath
}

const getResolvedTempPath = ({
  pathValue,
  runtimeOptions,
}: {
  pathValue: string
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}) => {
  return resolveProjectTransferTempWritablePath({...runtimeOptions, pathValue})
}

const getResolvedPromotionPath = ({
  pathValue,
  runtimeOptions,
}: {
  pathValue: string
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}) => {
  return resolveProjectTransferPromotionWritablePath({...runtimeOptions, pathValue})
}

const isMissingFileError = (error: unknown) => {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && ((error as {code: unknown}).code === 'ENOENT' || (error as {code: unknown}).code === 'ENOTDIR')
  )
}

const readJsonFileIfPresent = async (filePath: string) => {
  try {
    return getJsonValue(JSON.parse(await readFile(filePath, 'utf8')))
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }

    throw new Error(`Project transfer promotion manifest is unreadable or malformed: ${filePath}`, {cause: error})
  }
}

const isPromotionMetadata = (value: unknown): value is ProjectTransferAssetPromotionMetadata => {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as ProjectTransferAssetPromotionMetadata).promotedPath === 'string'
  )
}

const getPromotionMetadataArray = (value: unknown) => {
  const parsed = getJsonValue(value)

  if (Array.isArray(parsed)) {
    return parsed.filter(isPromotionMetadata)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return []
  }

  const record = parsed as Record<string, unknown>
  const values = [record.assets, record.promotedAssets, record.promotions]
  const metadata = values.find((entry) => {
    return Array.isArray(entry)
  })

  return Array.isArray(metadata) ? metadata.filter(isPromotionMetadata) : []
}

const removeTempArtifacts = async ({
  plan,
  runtimeOptions,
}: {
  plan: ProjectTransferRecoveryCleanupPlan
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}) => {
  const tempPath = getResolvedTempPath({pathValue: getTempRootPath(plan), runtimeOptions})
  await rm(tempPath, {force: true, recursive: true})
  return 1
}

const removePromotedAsset = async ({
  metadata,
  plan,
  runtimeOptions,
}: {
  metadata: ProjectTransferAssetPromotionMetadata
  plan: ProjectTransferRecoveryCleanupPlan
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}): Promise<ProjectTransferPromotedAssetCleanupResult> => {
  const validation = validateProjectTransferPromotionWritablePath(metadata.promotedPath)
  const isOwnedBySession =
    metadata.sessionId === plan.id && metadata.promotedPath.startsWith(`assets/project-transfer/${plan.id}/`)

  if (!validation.ok || !isOwnedBySession) {
    return {deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 1}
  }

  const promotedPath = getResolvedPromotionPath({pathValue: metadata.promotedPath, runtimeOptions})
  await rm(promotedPath, {force: true, recursive: false})
  return {deletedPromotedAssetCount: 1, skippedPromotedAssetCount: 0}
}

const mergePromotedAssetCleanupResult = (
  left: ProjectTransferPromotedAssetCleanupResult,
  right: ProjectTransferPromotedAssetCleanupResult,
): ProjectTransferPromotedAssetCleanupResult => {
  return {
    deletedPromotedAssetCount: left.deletedPromotedAssetCount + right.deletedPromotedAssetCount,
    skippedPromotedAssetCount: left.skippedPromotedAssetCount + right.skippedPromotedAssetCount,
  }
}

const removePromotedAssets = async ({
  plan,
  runtimeOptions,
}: {
  plan: ProjectTransferRecoveryCleanupPlan
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}): Promise<ProjectTransferPromotedAssetCleanupResult> => {
  if (!plan.deletePromotedAssets) {
    return {deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 0}
  }

  const manifestPath = getResolvedTempPath({pathValue: getPromotionManifestPath(plan), runtimeOptions})
  const metadata = getPromotionMetadataArray(await readJsonFileIfPresent(manifestPath))

  return metadata.reduce<Promise<ProjectTransferPromotedAssetCleanupResult>>(
    async (promise, entry) => {
      const current = await promise
      const next = await removePromotedAsset({metadata: entry, plan, runtimeOptions})

      return mergePromotedAssetCleanupResult(current, next)
    },
    Promise.resolve({deletedPromotedAssetCount: 0, skippedPromotedAssetCount: 0}),
  )
}

const cleanupRecoveredSessionArtifacts = async ({
  plan,
  runtimeOptions,
}: {
  plan: ProjectTransferRecoveryCleanupPlan
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}) => {
  const promotedAssetCleanup = await removePromotedAssets({plan, runtimeOptions})
  const cleanupTempArtifactCount = plan.deleteTempArtifacts ? await removeTempArtifacts({plan, runtimeOptions}) : 0

  return {...promotedAssetCleanup, cleanupTempArtifactCount}
}

const getRecoveryCounts = (
  plans: ProjectTransferRecoveryCleanupPlan[],
): Pick<ProjectTransferSessionRecoveryResult, 'expiredSessionCount' | 'recoveredCompletionCount'> => {
  return plans.reduce(
    (counts, plan) => {
      return {
        expiredSessionCount: counts.expiredSessionCount + (plan.transitionedToExpired ? 1 : 0),
        recoveredCompletionCount: counts.recoveredCompletionCount + (plan.recoveredFromHistory ? 1 : 0),
      }
    },
    {expiredSessionCount: 0, recoveredCompletionCount: 0},
  )
}

const emptyCleanupResult = (): ProjectTransferCleanupResult => {
  return {
    cleanupTempArtifactCount: 0,
    deletedPromotedAssetCount: 0,
    failedPlans: [],
    skippedPromotedAssetCount: 0,
    successfulPlans: [],
  }
}

const getCleanupFailureError = (failedPlans: ProjectTransferCleanupFailure[]) => {
  if (failedPlans.length === 0) {
    return null
  }

  if (failedPlans.length === 1) {
    return failedPlans[0]?.error ?? new Error('Project transfer cleanup failed')
  }

  const sessionIds = failedPlans.map((failure) => {
    return failure.plan.id
  })

  return new AggregateError(
    failedPlans.map((failure) => {
      return failure.error
    }),
    `Project transfer cleanup failed for ${failedPlans.length} sessions: ${sessionIds.join(', ')}`,
  )
}

const throwFailedCleanupPlans = (failedPlans: ProjectTransferCleanupFailure[]) => {
  const error = getCleanupFailureError(failedPlans)

  if (error !== null) {
    throw error
  }
}

const getCleanupAttempt = async ({
  plan,
  runtimeOptions,
}: {
  plan: ProjectTransferRecoveryCleanupPlan
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}) => {
  try {
    return {ok: true as const, result: await cleanupRecoveredSessionArtifacts({plan, runtimeOptions})}
  } catch (error) {
    return {error, ok: false as const}
  }
}

const getCleanupCounts = async ({
  plans,
  runtimeOptions,
}: {
  plans: ProjectTransferRecoveryCleanupPlan[]
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
}): Promise<ProjectTransferCleanupResult> => {
  return plans.reduce<Promise<ProjectTransferCleanupResult>>(async (promise, plan) => {
    const counts = await promise
    const cleanup = await getCleanupAttempt({plan, runtimeOptions})

    if (!cleanup.ok) {
      counts.failedPlans.push({error: cleanup.error, plan})

      return counts
    }

    counts.successfulPlans.push(plan)

    return {
      cleanupTempArtifactCount: counts.cleanupTempArtifactCount + cleanup.result.cleanupTempArtifactCount,
      deletedPromotedAssetCount: counts.deletedPromotedAssetCount + cleanup.result.deletedPromotedAssetCount,
      failedPlans: counts.failedPlans,
      skippedPromotedAssetCount: counts.skippedPromotedAssetCount + cleanup.result.skippedPromotedAssetCount,
      successfulPlans: counts.successfulPlans,
    }
  }, Promise.resolve(emptyCleanupResult()))
}

const markTerminalCleanupComplete = async ({
  now,
  plans,
  runner,
}: {
  now: Date
  plans: ProjectTransferRecoveryCleanupPlan[]
  runner: ProjectTransferSessionRecoveryRunner
}) => {
  const sessionIds = plans.map((plan) => {
    return plan.id
  })

  if (sessionIds.length === 0) {
    return
  }

  await runner.run(`
    UPDATE app.project_transfer_session
    SET terminal_cleanup_at = ${getTimestampLiteral(now)}
    WHERE id IN (${getQuotedStringList(sessionIds).join(', ')})
      AND state IN (${terminalStateListSql})
  `)
}

const runProjectTransferSessionRecovery = async (params: ProjectTransferSessionRecoveryParams = {}) => {
  const isActiveWriter = params.isActiveWriter ?? canCurrentServerOwnDuckdb

  if (!isActiveWriter()) {
    return emptyRecoveryResult(true)
  }

  const now = params.now ?? new Date()
  const ownerToken = getRecoveryOwnerToken(params.ownerToken)
  const runner = getRunner(params.runner)
  const batchSize = getRecoveryBatchSize(params.batchSize)
  const sessions = await getStaleProjectTransferSessions({batchSize, now, runner})
  const plans = runner.transaction
    ? await runner.transaction((tx) => {
        return getCleanupPlans({now, ownerToken, runner: tx, sessions})
      })
    : await getCleanupPlans({now, ownerToken, runner, sessions})
  const recoveryCounts = getRecoveryCounts(plans)
  const cleanupCounts = await getCleanupCounts({plans, runtimeOptions: {cwd: params.cwd, envValues: params.envValues}})
  const {failedPlans, successfulPlans, ...cleanupResultCounts} = cleanupCounts
  await markTerminalCleanupComplete({now, plans: successfulPlans, runner})
  throwFailedCleanupPlans(failedPlans)

  return {
    ...recoveryCounts,
    ...cleanupResultCounts,
    scannedSessionCount: sessions.length,
    skippedActiveWriterCheck: false,
  }
}

const projectTransferSessionRecoveryService = {
  runProjectTransferSessionRecovery,
  runProjectTransferStartupRecovery: runProjectTransferSessionRecovery,
  runProjectTransferTtlRecovery: runProjectTransferSessionRecovery,
}

export const getProjectTransferSessionRecoveryService = () => {
  return projectTransferSessionRecoveryService
}

export const runProjectTransferStartupRecovery = projectTransferSessionRecoveryService.runProjectTransferStartupRecovery

export const runProjectTransferTtlRecovery = projectTransferSessionRecoveryService.runProjectTransferTtlRecovery

export type {ProjectTransferSessionRecoveryParams, ProjectTransferSessionRecoveryResult}

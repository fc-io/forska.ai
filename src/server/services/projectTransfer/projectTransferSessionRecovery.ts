import {randomUUID} from 'node:crypto'
import {readFile, rm} from 'node:fs/promises'

import type {
  ProjectTransferDirection,
  ProjectTransferHistoryRecord,
  ProjectTransferSessionState,
} from '../../../db/schemaTypes.ts'
import {writeRuntimeLogEvent} from '../../utils/runtimeLogger.ts'
import {canCurrentServerOwnDuckdb} from '../../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../appQueryHelpers.ts'
import type {ProjectTransferAssetPromotionMetadata, ProjectTransferRuntimeEvent} from './projectTransferContracts.ts'
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
import {removeProjectTransferStaleStagingRevisions} from './projectTransferStaging.ts'

type ProjectTransferSessionRecoveryRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction?: <T>(operation: (runner: ProjectTransferSessionRecoveryRunner) => Promise<T>) => Promise<T>
}

type ProjectTransferSessionRecoveryRuntimeOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

type ProjectTransferSessionRecoveryParams = ProjectTransferSessionRecoveryRuntimeOptions & {
  batchSize?: number
  exportOwnerHeartbeatStaleMs?: number
  exportQueuedSessionStaleMs?: number
  importAnalyzeHeartbeatStaleMs?: number
  importCommitHeartbeatStaleMs?: number
  isActiveWriter?: () => boolean
  now?: Date
  ownerToken?: string
  runner?: ProjectTransferSessionRecoveryRunner
}

type ProjectTransferRecoveryKind =
  | 'expired_or_terminal'
  | 'stale_import_analysis'
  | 'stale_import_commit'
  | 'stale_import_upload'

type ProjectTransferRecoveryCandidate = {
  direction: ProjectTransferDirection
  id: string
  ownerToken: string | null
  recoveryKind: ProjectTransferRecoveryKind
  state: ProjectTransferSessionState
}

type ProjectTransferRecoveryCleanupPlan = ProjectTransferRecoveryCandidate & {
  deletePromotedAssets: boolean
  deleteTempArtifacts: boolean
  recoveredFromHistory: boolean
  transitionedToFailed: boolean
  transitionedToExpired: boolean
}

type ProjectTransferPromotedAssetCleanupResult = {deletedPromotedAssetCount: number; skippedPromotedAssetCount: number}

type ProjectTransferSessionRecoveryResult = ProjectTransferPromotedAssetCleanupResult & {
  cleanupTempArtifactCount: number
  cleanupStaleStagingRevisionCount: number
  expiredSessionCount: number
  recoveredCompletionCount: number
  scannedSessionCount: number
  skippedActiveWriterCheck: boolean
}

type ProjectTransferCleanupCounts = Pick<
  ProjectTransferSessionRecoveryResult,
  | 'cleanupStaleStagingRevisionCount'
  | 'cleanupTempArtifactCount'
  | 'deletedPromotedAssetCount'
  | 'skippedPromotedAssetCount'
>

type ProjectTransferCleanupFailure = {error: unknown; plan: ProjectTransferRecoveryCleanupPlan}

type ProjectTransferCleanupResult = ProjectTransferCleanupCounts & {
  failedPlans: ProjectTransferCleanupFailure[]
  successfulPlans: ProjectTransferRecoveryCleanupPlan[]
}

const defaultRecoveryBatchSize = 50
const defaultExportOwnerHeartbeatStaleMs = 5 * 60 * 1000
const defaultExportQueuedSessionStaleMs = 10 * 60 * 1000
const defaultImportAnalyzeHeartbeatStaleMs = 5 * 60 * 1000
const defaultImportCommitHeartbeatStaleMs = 5 * 60 * 1000
const defaultTerminalSessionPruneAgeMs = 24 * 60 * 60 * 1000
const maxRecoveryBatchSize = 500
const terminalStateListSql = getQuotedStringList([...projectTransferTerminalStates]).join(', ')

const emptyRecoveryResult = (skippedActiveWriterCheck: boolean): ProjectTransferSessionRecoveryResult => {
  return {
    cleanupTempArtifactCount: 0,
    cleanupStaleStagingRevisionCount: 0,
    deletedPromotedAssetCount: 0,
    expiredSessionCount: 0,
    recoveredCompletionCount: 0,
    scannedSessionCount: 0,
    skippedActiveWriterCheck,
    skippedPromotedAssetCount: 0,
  }
}

const getStagingRevisionJsonSql = () => {
  return "COALESCE(progress_json->>'stagingRevision', progress_json->'staging'->>'stagingRevision', progress_json->'staging'->>'currentRevision')"
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

const getDateBefore = ({ms, now}: {ms: number; now: Date}) => {
  return new Date(now.getTime() - ms)
}

const getStaleProjectTransferSessions = async ({
  batchSize,
  exportOwnerHeartbeatStaleMs,
  exportQueuedSessionStaleMs,
  importAnalyzeHeartbeatStaleMs,
  importCommitHeartbeatStaleMs,
  now,
  runner,
}: {
  batchSize: number
  exportOwnerHeartbeatStaleMs: number
  exportQueuedSessionStaleMs: number
  importAnalyzeHeartbeatStaleMs: number
  importCommitHeartbeatStaleMs: number
  now: Date
  runner: ProjectTransferSessionRecoveryRunner
}) => {
  const staleExportQueuedBefore = getDateBefore({ms: exportQueuedSessionStaleMs, now})
  const staleExportHeartbeatBefore = getDateBefore({ms: exportOwnerHeartbeatStaleMs, now})
  const staleImportAnalyzeHeartbeatBefore = getDateBefore({ms: importAnalyzeHeartbeatStaleMs, now})
  const staleImportCommitHeartbeatBefore = getDateBefore({ms: importCommitHeartbeatStaleMs, now})

  return runner.queryJson<ProjectTransferRecoveryCandidate>(`
    SELECT
      direction,
      id,
      owner_token AS ownerToken,
      CASE
        WHEN direction = 'import'
          AND state = 'uploading'
          AND owner_token IS NOT NULL
          AND expires_at > ${getTimestampLiteral(now)}
          AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleImportAnalyzeHeartbeatBefore)}
          THEN 'stale_import_upload'
        WHEN direction = 'import'
          AND state IN ('extracting', 'analyzing')
          AND owner_token IS NOT NULL
          AND expires_at > ${getTimestampLiteral(now)}
          AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleImportAnalyzeHeartbeatBefore)}
          THEN 'stale_import_analysis'
        WHEN direction = 'import'
          AND state = 'committing'
          AND owner_token IS NOT NULL
          AND expires_at > ${getTimestampLiteral(now)}
          AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleImportCommitHeartbeatBefore)}
          THEN 'stale_import_commit'
        ELSE 'expired_or_terminal'
      END AS recoveryKind,
      state
    FROM app.project_transfer_session
    WHERE (
        direction = 'import'
        AND expires_at <= ${getTimestampLiteral(now)}
        AND (state NOT IN (${terminalStateListSql}) OR terminal_cleanup_at IS NULL)
      )
      OR (
        direction = 'import'
        AND state = 'uploading'
        AND owner_token IS NOT NULL
        AND expires_at > ${getTimestampLiteral(now)}
        AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleImportAnalyzeHeartbeatBefore)}
      )
      OR (
        direction = 'import'
        AND state IN ('extracting', 'analyzing')
        AND owner_token IS NOT NULL
        AND expires_at > ${getTimestampLiteral(now)}
        AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleImportAnalyzeHeartbeatBefore)}
      )
      OR (
        direction = 'import'
        AND state = 'committing'
        AND owner_token IS NOT NULL
        AND expires_at > ${getTimestampLiteral(now)}
        AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleImportCommitHeartbeatBefore)}
      )
      OR (
        direction = 'export'
        AND (
          (state = 'ready' AND expires_at <= ${getTimestampLiteral(now)})
          OR (state = 'queued' AND owner_token IS NULL AND updated_at <= ${getTimestampLiteral(staleExportQueuedBefore)})
          OR (
            state IN ('assembling', 'packaging')
            AND owner_token IS NOT NULL
            AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleExportHeartbeatBefore)}
          )
          OR (state IN ('failed', 'expired') AND terminal_cleanup_at IS NULL)
        )
      )
    ORDER BY
      CASE WHEN state IN (${terminalStateListSql}) THEN 1 ELSE 0 END ASC,
      CASE WHEN direction = 'export' AND state IN ('assembling', 'packaging') THEN 0 ELSE 1 END ASC,
      COALESCE(heartbeat_at, expires_at) ASC,
      updated_at ASC,
      id ASC
    LIMIT ${batchSize}
  `)
}

const getImportRecoveryCondition = ({
  now,
  session,
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
}: {
  now: Date
  session: ProjectTransferRecoveryCandidate
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
}) => {
  const staleHeartbeatBefore =
    session.recoveryKind === 'stale_import_commit'
      ? staleImportCommitHeartbeatBefore
      : staleImportAnalyzeHeartbeatBefore

  return session.recoveryKind === 'expired_or_terminal'
    ? `AND expires_at <= ${getTimestampLiteral(now)}`
    : `AND owner_token = ${getSqlLiteral(session.ownerToken)}
       AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleHeartbeatBefore)}`
}

const transitionImportSessionToCompletedFromHistory = async ({
  history,
  now,
  runner,
  session,
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
}: {
  history: ProjectTransferHistoryRecord
  now: Date
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
}) => {
  const completionPayload = parseProjectTransferCompletionPayload(history.completionPayloadJson, 'import')

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
      ${getImportRecoveryCondition({now, session, staleImportAnalyzeHeartbeatBefore, staleImportCommitHeartbeatBefore})}
    RETURNING direction, id, state
  `)

  return row ?? null
}

const transitionImportUploadSessionToFailed = async ({
  now,
  ownerToken,
  runner,
  session,
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
}) => {
  const [row] = await runner.queryJson<ProjectTransferRecoveryCandidate>(`
    UPDATE app.project_transfer_session
    SET
      state = 'failed',
      owner_token = ${getSqlLiteral(ownerToken)},
      error_json = ${getJsonLiteral({reason: 'project_transfer_import_upload_worker_stale'})},
      updated_at = ${getTimestampLiteral(now)}
    WHERE id = ${getSqlLiteral(session.id)}
      AND direction = 'import'
      AND state = 'uploading'
      ${getImportRecoveryCondition({now, session, staleImportAnalyzeHeartbeatBefore, staleImportCommitHeartbeatBefore})}
    RETURNING direction, id, state
  `)

  return row ?? null
}

const transitionImportAnalyzeSessionToFailed = async ({
  now,
  ownerToken,
  runner,
  session,
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
}) => {
  const [row] = await runner.queryJson<ProjectTransferRecoveryCandidate>(`
    UPDATE app.project_transfer_session
    SET
      state = 'failed',
      owner_token = ${getSqlLiteral(ownerToken)},
      error_json = ${getJsonLiteral({reason: 'project_transfer_import_analysis_worker_stale'})},
      updated_at = ${getTimestampLiteral(now)}
    WHERE id = ${getSqlLiteral(session.id)}
      AND direction = 'import'
      AND state IN ('extracting', 'analyzing')
      ${getImportRecoveryCondition({now, session, staleImportAnalyzeHeartbeatBefore, staleImportCommitHeartbeatBefore})}
    RETURNING direction, id, state
  `)

  return row ?? null
}

const transitionImportCommitSessionToFailed = async ({
  now,
  ownerToken,
  runner,
  session,
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
}) => {
  const [row] = await runner.queryJson<ProjectTransferRecoveryCandidate>(`
    UPDATE app.project_transfer_session
    SET
      state = 'failed',
      owner_token = ${getSqlLiteral(ownerToken)},
      error_json = ${getJsonLiteral({reason: 'project_transfer_import_commit_worker_stale'})},
      updated_at = ${getTimestampLiteral(now)}
    WHERE id = ${getSqlLiteral(session.id)}
      AND direction = 'import'
      AND state = 'committing'
      ${getImportRecoveryCondition({now, session, staleImportAnalyzeHeartbeatBefore, staleImportCommitHeartbeatBefore})}
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

const transitionExportSessionToFailed = async ({
  now,
  ownerToken,
  runner,
  session,
  staleExportHeartbeatBefore,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
  staleExportHeartbeatBefore: Date
}) => {
  const activeWorkerCondition =
    session.state === 'assembling' || session.state === 'packaging'
      ? `
       AND owner_token = ${getSqlLiteral(session.ownerToken)}
       AND COALESCE(heartbeat_at, updated_at) <= ${getTimestampLiteral(staleExportHeartbeatBefore)}`
      : ''
  const [row] = await runner.queryJson<ProjectTransferRecoveryCandidate>(`
    UPDATE app.project_transfer_session
    SET
      state = 'failed',
      owner_token = ${getSqlLiteral(ownerToken)},
      error_json = ${getJsonLiteral({reason: 'project_transfer_export_worker_stale'})},
      updated_at = ${getTimestampLiteral(now)}
    WHERE id = ${getSqlLiteral(session.id)}
      AND direction = 'export'
      AND state = ${getSqlLiteral(session.state)}
      ${activeWorkerCondition}
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
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
  staleExportHeartbeatBefore,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  session: ProjectTransferRecoveryCandidate
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
  staleExportHeartbeatBefore: Date
}): Promise<ProjectTransferRecoveryCleanupPlan | null> => {
  const history = await getCompletedImportHistory({runner, session})
  const shouldRecoverFromHistory = history !== null && session.state !== 'completed'

  if (shouldRecoverFromHistory) {
    const completedSession = await transitionImportSessionToCompletedFromHistory({
      history,
      now,
      runner,
      session,
      staleImportAnalyzeHeartbeatBefore,
      staleImportCommitHeartbeatBefore,
    })

    return completedSession === null
      ? null
      : {
          ...session,
          deletePromotedAssets: false,
          deleteTempArtifacts: true,
          recoveredFromHistory: true,
          transitionedToFailed: false,
          transitionedToExpired: false,
        }
  }

  if (isProjectTransferTerminalState(session.state)) {
    return {
      ...session,
      deletePromotedAssets: session.direction === 'import' && session.state !== 'completed' && history === null,
      deleteTempArtifacts: true,
      recoveredFromHistory: false,
      transitionedToFailed: false,
      transitionedToExpired: false,
    }
  }

  if (session.recoveryKind === 'stale_import_upload') {
    const failedSession = await transitionImportUploadSessionToFailed({
      now,
      ownerToken,
      runner,
      session,
      staleImportAnalyzeHeartbeatBefore,
      staleImportCommitHeartbeatBefore,
    })

    return failedSession === null
      ? null
      : {
          ...session,
          deletePromotedAssets: false,
          deleteTempArtifacts: true,
          recoveredFromHistory: false,
          transitionedToFailed: true,
          transitionedToExpired: false,
        }
  }

  if (session.recoveryKind === 'stale_import_analysis') {
    const failedSession = await transitionImportAnalyzeSessionToFailed({
      now,
      ownerToken,
      runner,
      session,
      staleImportAnalyzeHeartbeatBefore,
      staleImportCommitHeartbeatBefore,
    })

    return failedSession === null
      ? null
      : {
          ...session,
          deletePromotedAssets: true,
          deleteTempArtifacts: true,
          recoveredFromHistory: false,
          transitionedToFailed: true,
          transitionedToExpired: false,
        }
  }

  if (session.recoveryKind === 'stale_import_commit') {
    const failedSession = await transitionImportCommitSessionToFailed({
      now,
      ownerToken,
      runner,
      session,
      staleImportAnalyzeHeartbeatBefore,
      staleImportCommitHeartbeatBefore,
    })

    return failedSession === null
      ? null
      : {
          ...session,
          deletePromotedAssets: true,
          deleteTempArtifacts: true,
          recoveredFromHistory: false,
          transitionedToFailed: true,
          transitionedToExpired: false,
        }
  }

  const expiredSession =
    session.direction === 'export' && session.state !== 'ready'
      ? await transitionExportSessionToFailed({now, ownerToken, runner, session, staleExportHeartbeatBefore})
      : await transitionSessionToExpired({now, ownerToken, runner, session})

  return expiredSession === null
    ? null
    : {
        ...session,
        deletePromotedAssets: session.direction === 'import' && history === null,
        deleteTempArtifacts: true,
        recoveredFromHistory: false,
        transitionedToFailed: false,
        transitionedToExpired: expiredSession.state === 'expired',
      }
}

const getCleanupPlans = async ({
  now,
  ownerToken,
  runner,
  sessions,
  staleImportAnalyzeHeartbeatBefore,
  staleImportCommitHeartbeatBefore,
  staleExportHeartbeatBefore,
}: {
  now: Date
  ownerToken: string
  runner: ProjectTransferSessionRecoveryRunner
  sessions: ProjectTransferRecoveryCandidate[]
  staleImportAnalyzeHeartbeatBefore: Date
  staleImportCommitHeartbeatBefore: Date
  staleExportHeartbeatBefore: Date
}) => {
  return sessions.reduce<Promise<ProjectTransferRecoveryCleanupPlan[]>>(async (promise, session) => {
    const plans = await promise
    const plan = await getCleanupPlanForSession({
      now,
      ownerToken,
      runner,
      session,
      staleExportHeartbeatBefore,
      staleImportAnalyzeHeartbeatBefore,
      staleImportCommitHeartbeatBefore,
    })

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

  return {...promotedAssetCleanup, cleanupStaleStagingRevisionCount: 0, cleanupTempArtifactCount}
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

const getRecoveryCommitEventState = (plan: ProjectTransferRecoveryCleanupPlan) => {
  return plan.recoveredFromHistory
    ? 'completed'
    : plan.transitionedToExpired
      ? 'expired'
      : plan.transitionedToFailed
        ? 'failed'
        : plan.state
}

const getRecoveryCommitEventStatus = (plan: ProjectTransferRecoveryCleanupPlan) => {
  return plan.recoveredFromHistory
    ? 'completed'
    : plan.transitionedToFailed || plan.deletePromotedAssets
      ? 'failed'
      : 'running'
}

const getRecoveryCommitEventMessage = (plan: ProjectTransferRecoveryCleanupPlan) => {
  return plan.recoveredFromHistory
    ? 'Recovered completed import commit from transfer history'
    : plan.deletePromotedAssets
      ? 'Recovered failed import commit and selected promoted asset cleanup'
      : 'Recovered import commit session without promoted asset cleanup'
}

const writeProjectTransferRecoveryRuntimeEvents = ({
  now,
  ownerToken,
  plans,
}: {
  now: Date
  ownerToken: string
  plans: ProjectTransferRecoveryCleanupPlan[]
}) => {
  return plans
    .filter((plan) => {
      return plan.direction === 'import'
    })
    .map((plan) => {
      const timestamp = now.toISOString()
      const event: ProjectTransferRuntimeEvent = {
        direction: 'import',
        eventId: randomUUID(),
        eventType: 'commit_progress',
        message: getRecoveryCommitEventMessage(plan),
        ownerToken,
        phase: 'commit',
        planRevision: 0,
        sessionId: plan.id,
        state: getRecoveryCommitEventState(plan),
        status: getRecoveryCommitEventStatus(plan),
        timestamp,
      }

      writeRuntimeLogEvent({
        attrs: event,
        event: 'project_transfer.commit_progress',
        message: event.message ?? 'Project transfer commit recovery decision',
        severity: event.status === 'failed' ? 'WARN' : 'INFO',
        timestamp,
      })

      return event
    })
}

const emptyCleanupResult = (): ProjectTransferCleanupResult => {
  return {
    cleanupStaleStagingRevisionCount: 0,
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
      cleanupStaleStagingRevisionCount:
        counts.cleanupStaleStagingRevisionCount + cleanup.result.cleanupStaleStagingRevisionCount,
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

const pruneExpiredTerminalSessions = async ({
  batchSize,
  now,
  runner,
}: {
  batchSize: number
  now: Date
  runner: ProjectTransferSessionRecoveryRunner
}) => {
  const pruneBefore = getDateBefore({ms: defaultTerminalSessionPruneAgeMs, now})
  const rows = await runner.queryJson<{id: string}>(`
    SELECT id
    FROM app.project_transfer_session
    WHERE state IN (${terminalStateListSql})
      AND terminal_cleanup_at IS NOT NULL
      AND expires_at <= ${getTimestampLiteral(now)}
      AND terminal_cleanup_at <= ${getTimestampLiteral(pruneBefore)}
    ORDER BY expires_at ASC, terminal_cleanup_at ASC, id ASC
    LIMIT ${batchSize}
  `)
  const sessionIds = rows.map((row) => {
    return row.id
  })

  if (sessionIds.length === 0) {
    return
  }

  await runner.run(`
    DELETE FROM app.project_transfer_session
    WHERE id IN (${getQuotedStringList(sessionIds).join(', ')})
  `)
}

const cleanupStaleLiveImportStagingRevisions = async ({
  batchSize,
  now,
  runtimeOptions,
  runner,
}: {
  batchSize: number
  now: Date
  runtimeOptions: ProjectTransferSessionRecoveryRuntimeOptions
  runner: ProjectTransferSessionRecoveryRunner
}) => {
  const rows = await runner.queryJson<{id: string; stagingRevision: number}>(`
    SELECT
      id,
      TRY_CAST(${getStagingRevisionJsonSql()} AS INTEGER) AS stagingRevision
    FROM app.project_transfer_session
    WHERE direction = 'import'
      AND state IN ('awaiting_resolution', 'ready_to_commit')
      AND owner_token IS NULL
      AND expires_at > ${getTimestampLiteral(now)}
      AND ${getStagingRevisionJsonSql()} IS NOT NULL
      AND TRY_CAST(${getStagingRevisionJsonSql()} AS INTEGER) IS NOT NULL
    ORDER BY updated_at ASC, id ASC
    LIMIT ${batchSize}
  `)

  return rows.reduce<Promise<number>>(async (promise, row) => {
    const count = await promise

    return (
      count
      + (await removeProjectTransferStaleStagingRevisions({
        currentStagingRevision: row.stagingRevision,
        layout: getProjectTransferImportTempLayout(row.id),
        runtimeOptions,
      }))
    )
  }, Promise.resolve(0))
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
  const exportOwnerHeartbeatStaleMs = params.exportOwnerHeartbeatStaleMs ?? defaultExportOwnerHeartbeatStaleMs
  const exportQueuedSessionStaleMs = params.exportQueuedSessionStaleMs ?? defaultExportQueuedSessionStaleMs
  const importAnalyzeHeartbeatStaleMs = params.importAnalyzeHeartbeatStaleMs ?? defaultImportAnalyzeHeartbeatStaleMs
  const importCommitHeartbeatStaleMs = params.importCommitHeartbeatStaleMs ?? defaultImportCommitHeartbeatStaleMs
  const staleExportHeartbeatBefore = getDateBefore({ms: exportOwnerHeartbeatStaleMs, now})
  const staleImportAnalyzeHeartbeatBefore = getDateBefore({ms: importAnalyzeHeartbeatStaleMs, now})
  const staleImportCommitHeartbeatBefore = getDateBefore({ms: importCommitHeartbeatStaleMs, now})
  const sessions = await getStaleProjectTransferSessions({
    batchSize,
    exportOwnerHeartbeatStaleMs,
    exportQueuedSessionStaleMs,
    importAnalyzeHeartbeatStaleMs,
    importCommitHeartbeatStaleMs,
    now,
    runner,
  })
  const plans = runner.transaction
    ? await runner.transaction((tx) => {
        return getCleanupPlans({
          now,
          ownerToken,
          runner: tx,
          sessions,
          staleExportHeartbeatBefore,
          staleImportAnalyzeHeartbeatBefore,
          staleImportCommitHeartbeatBefore,
        })
      })
    : await getCleanupPlans({
        now,
        ownerToken,
        runner,
        sessions,
        staleExportHeartbeatBefore,
        staleImportAnalyzeHeartbeatBefore,
        staleImportCommitHeartbeatBefore,
      })
  writeProjectTransferRecoveryRuntimeEvents({now, ownerToken, plans})
  const recoveryCounts = getRecoveryCounts(plans)
  const cleanupCounts = await getCleanupCounts({plans, runtimeOptions: {cwd: params.cwd, envValues: params.envValues}})
  const {failedPlans, successfulPlans, ...cleanupResultCounts} = cleanupCounts
  await markTerminalCleanupComplete({now, plans: successfulPlans, runner})
  const cleanupStaleStagingRevisionCount = await cleanupStaleLiveImportStagingRevisions({
    batchSize,
    now,
    runner,
    runtimeOptions: {cwd: params.cwd, envValues: params.envValues},
  })
  await pruneExpiredTerminalSessions({batchSize, now, runner})
  throwFailedCleanupPlans(failedPlans)

  return {
    ...recoveryCounts,
    ...cleanupResultCounts,
    cleanupStaleStagingRevisionCount:
      cleanupResultCounts.cleanupStaleStagingRevisionCount + cleanupStaleStagingRevisionCount,
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

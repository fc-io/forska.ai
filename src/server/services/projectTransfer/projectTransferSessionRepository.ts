import type {
  ProjectTransferDirection,
  ProjectTransferSessionRecord,
  ProjectTransferSessionState,
} from '../../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral, getTimestampLiteral} from '../appQueryHelpers.ts'
import {
  assertProjectTransferSessionId,
  isProjectTransferStateForDirection,
  isProjectTransferWriterOnlyState,
  parseProjectTransferPlanSummary,
  parseProjectTransferProgressPayload,
  type ProjectTransferCompletionPayload,
  type ProjectTransferExportReadyPayload,
  type ProjectTransferPlanSummary,
  type ProjectTransferProgressPayload,
  validateProjectTransferPlanReadyToCommit,
  validateProjectTransferProgressUpdate,
} from './projectTransferSession.ts'

type ProjectTransferSessionRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type CreateProjectTransferSessionParams = {
  direction: ProjectTransferDirection
  expiresAt: Date
  id: string
  now?: Date
  packageFingerprint?: string | null
  planSummary?: ProjectTransferPlanSummary | null
  progress?: ProjectTransferProgressPayload | null
  runner?: ProjectTransferSessionRunner
  state?: ProjectTransferSessionState
}

type ProjectTransferOwnerTokenCondition = {expectedOwnerToken?: string | null}

type ProjectTransferPlanRevisionCondition = {expectedPlanRevision?: number}

type TransitionProjectTransferSessionStateParams = ProjectTransferOwnerTokenCondition
  & ProjectTransferPlanRevisionCondition & {
    commitId?: string | null
    completionPayload?: ProjectTransferCompletionPayload | null
    error?: unknown
    expectedState: ProjectTransferSessionState | ProjectTransferSessionState[]
    nextOwnerLeaseMs?: number
    nextOwnerToken?: string | null
    nextState: ProjectTransferSessionState
    now?: Date
    packageFingerprint?: string | null
    planSummary?: ProjectTransferPlanSummary | null
    progress?: ProjectTransferProgressPayload | null
    runner?: ProjectTransferSessionRunner
    sessionId: string
  }

type UpdateProjectTransferSessionPlanParams = ProjectTransferOwnerTokenCondition & {
  expectedPlanRevision: number
  nextState?: ProjectTransferSessionState
  now?: Date
  planSummary: ProjectTransferPlanSummary
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type HeartbeatProjectTransferSessionOwnerParams = {
  leaseMs: number
  now?: Date
  ownerToken: string
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type ClaimProjectTransferExportSessionOwnerParams = {
  expectedState: 'queued' | 'assembling' | 'packaging'
  nextState: 'assembling' | 'packaging'
  now?: Date
  ownerToken: string
  progress?: ProjectTransferProgressPayload | null
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type HeartbeatProjectTransferExportSessionOwnerParams = {
  now?: Date
  ownerToken: string
  progress?: ProjectTransferProgressPayload | null
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type FailProjectTransferSessionExportParams = {
  error: unknown
  now?: Date
  ownerToken: string
  progress?: ProjectTransferProgressPayload | null
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type UpdateProjectTransferSessionProgressParams = ProjectTransferOwnerTokenCondition & {
  now?: Date
  progress: ProjectTransferProgressPayload
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type PersistProjectTransferSessionCompletionParams = {
  completionPayload: ProjectTransferCompletionPayload
  expectedPlanRevision?: number
  now?: Date
  ownerToken: string
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type PersistProjectTransferSessionExportReadyParams = {
  completionPayload: ProjectTransferExportReadyPayload
  now?: Date
  ownerToken: string
  progress?: ProjectTransferProgressPayload | null
  runner?: ProjectTransferSessionRunner
  sessionId: string
}

type GetProjectTransferSessionParams = {runner?: ProjectTransferSessionRunner; sessionId: string}

const defaultProjectTransferOwnerLeaseMs = 60_000

const getNow = (now?: Date) => {
  return now ?? new Date()
}

const getRunner = (runner?: ProjectTransferSessionRunner) => {
  return runner ?? getAppDatabaseService()
}

const getJsonLiteral = (value: unknown) => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getProjectTransferSessionSelectSql = () => {
  return `
    id,
    direction,
    state,
    CAST(plan_revision AS INTEGER) AS planRevision,
    package_fingerprint AS packageFingerprint,
    commit_id AS commitId,
    owner_token AS ownerToken,
    heartbeat_at AS heartbeatAt,
    expires_at AS expiresAt,
    TO_JSON(progress_json) AS progressJson,
    TO_JSON(plan_summary_json) AS planSummaryJson,
    TO_JSON(completion_payload_json) AS completionPayloadJson,
    TO_JSON(error_json) AS errorJson,
    created_at AS createdAt,
    terminal_cleanup_at AS terminalCleanupAt,
    updated_at AS updatedAt
  `
}

const mapProjectTransferSessionRecord = (
  row: Omit<
    ProjectTransferSessionRecord,
    'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'
  > & {completionPayloadJson: unknown; errorJson: unknown; planSummaryJson: unknown; progressJson: unknown},
): ProjectTransferSessionRecord => {
  return {
    ...row,
    completionPayloadJson: getJsonValue(row.completionPayloadJson),
    errorJson: getJsonValue(row.errorJson),
    planSummaryJson: getJsonValue(row.planSummaryJson),
    progressJson: getJsonValue(row.progressJson),
  }
}

const getStateCondition = (expectedState: ProjectTransferSessionState | ProjectTransferSessionState[]) => {
  return Array.isArray(expectedState)
    ? `state IN (${getQuotedStringList(expectedState).join(', ')})`
    : `state = ${getSqlLiteral(expectedState)}`
}

const getOwnerTokenCondition = (expectedOwnerToken: string | null | undefined) => {
  return expectedOwnerToken === undefined
    ? null
    : expectedOwnerToken === null
      ? 'owner_token IS NULL'
      : `owner_token = ${getSqlLiteral(expectedOwnerToken)}`
}

const getOptionalConditionsSql = (conditions: Array<string | null | undefined>) => {
  return conditions.filter(Boolean).join('\n      AND ')
}

const getPlanRevisionCondition = (expectedPlanRevision: number | undefined) => {
  return expectedPlanRevision === undefined ? null : `plan_revision = ${expectedPlanRevision}`
}

const getLeaseExpiresAt = ({leaseMs, now}: {leaseMs: number; now: Date}) => {
  return new Date(now.getTime() + leaseMs)
}

const getOwnerClaimLeaseMs = (leaseMs: number | undefined) => {
  if (leaseMs === undefined) {
    return defaultProjectTransferOwnerLeaseMs
  }

  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error('Project transfer owner lease must be positive')
  }

  return Math.floor(leaseMs)
}

const getProjectTransferSessionRecord = async (runner: ProjectTransferSessionRunner, sessionId: string) => {
  const [row] = await runner.queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    SELECT ${getProjectTransferSessionSelectSql()}
    FROM app.project_transfer_session
    WHERE id = ${getSqlLiteral(sessionId)}
    LIMIT 1
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const assertSessionStateForDirection = (direction: ProjectTransferDirection, state: ProjectTransferSessionState) => {
  if (!isProjectTransferStateForDirection(direction, state)) {
    throw new Error(`Project transfer state ${state} is invalid for ${direction} sessions`)
  }
}

const assertWriterOnlyStateOwnerToken = (
  nextState: ProjectTransferSessionState,
  expectedOwnerToken: string | null | undefined,
) => {
  if (isProjectTransferWriterOnlyState(nextState) && typeof expectedOwnerToken !== 'string') {
    throw new Error(`Project transfer state ${nextState} requires a writer owner token`)
  }
}

const assertReadyToCommitPlan = (
  nextState: ProjectTransferSessionState,
  planSummary: ProjectTransferPlanSummary | null,
) => {
  const validation =
    nextState === 'ready_to_commit' ? validateProjectTransferPlanReadyToCommit(planSummary) : {ok: true as const}

  if (!validation.ok) {
    throw new Error(validation.error)
  }
}

const assertProgressUpdate = ({
  next,
  previous,
}: {
  next: ProjectTransferProgressPayload | null | undefined
  previous: ProjectTransferProgressPayload | null
}) => {
  const validation =
    next === null || next === undefined ? {ok: true as const} : validateProjectTransferProgressUpdate({next, previous})

  if (!validation.ok) {
    throw new Error(validation.error)
  }
}

const getOwnerTokenUpdateSets = (params: TransitionProjectTransferSessionStateParams, now: Date) => {
  if (!Object.hasOwn(params, 'nextOwnerToken')) {
    return []
  }

  if (typeof params.nextOwnerToken !== 'string') {
    return [`owner_token = ${getSqlLiteral(params.nextOwnerToken ?? null)}`]
  }

  return [
    `owner_token = ${getSqlLiteral(params.nextOwnerToken)}`,
    `heartbeat_at = ${getTimestampLiteral(now)}`,
    `expires_at = ${getTimestampLiteral(getLeaseExpiresAt({leaseMs: getOwnerClaimLeaseMs(params.nextOwnerLeaseMs), now}))}`,
  ]
}

const getTransitionUpdateSets = (params: TransitionProjectTransferSessionStateParams, now: Date) => {
  return [
    `state = ${getSqlLiteral(params.nextState)}`,
    `updated_at = ${getTimestampLiteral(now)}`,
    ...getOwnerTokenUpdateSets(params, now),
    Object.hasOwn(params, 'commitId') ? `commit_id = ${getSqlLiteral(params.commitId ?? null)}` : null,
    Object.hasOwn(params, 'packageFingerprint')
      ? `package_fingerprint = ${getSqlLiteral(params.packageFingerprint ?? null)}`
      : null,
    Object.hasOwn(params, 'progress') ? `progress_json = ${getJsonLiteral(params.progress ?? null)}` : null,
    Object.hasOwn(params, 'planSummary') ? `plan_summary_json = ${getJsonLiteral(params.planSummary ?? null)}` : null,
    Object.hasOwn(params, 'completionPayload')
      ? `completion_payload_json = ${getJsonLiteral(params.completionPayload ?? null)}`
      : null,
    Object.hasOwn(params, 'error') ? `error_json = ${getJsonLiteral(params.error ?? null)}` : null,
  ].filter((set): set is string => {
    return set !== null
  })
}

const createProjectTransferSession = async (params: CreateProjectTransferSessionParams) => {
  const currentNow = getNow(params.now)
  const state = params.state ?? (params.direction === 'import' ? 'awaiting_upload' : 'queued')
  const runner = getRunner(params.runner)
  assertProjectTransferSessionId(params.id)
  assertSessionStateForDirection(params.direction, state)

  const [row] = await runner.queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    INSERT INTO app.project_transfer_session (
      id,
      direction,
      state,
      package_fingerprint,
      expires_at,
      progress_json,
      plan_summary_json,
      created_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(params.id)},
      ${getSqlLiteral(params.direction)},
      ${getSqlLiteral(state)},
      ${getSqlLiteral(params.packageFingerprint ?? null)},
      ${getTimestampLiteral(params.expiresAt)},
      ${getJsonLiteral(params.progress ?? null)},
      ${getJsonLiteral(params.planSummary ?? null)},
      ${getTimestampLiteral(currentNow)},
      ${getTimestampLiteral(currentNow)}
    )
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  if (!row) {
    throw new Error(`Failed to create project transfer session ${params.id}`)
  }

  return mapProjectTransferSessionRecord(row)
}

const getProjectTransferSession = async ({runner, sessionId}: GetProjectTransferSessionParams) => {
  return getProjectTransferSessionRecord(getRunner(runner), sessionId)
}

const getPlanSummaryForTransitionValidation = (
  params: TransitionProjectTransferSessionStateParams,
  current: ProjectTransferSessionRecord,
) => {
  return Object.hasOwn(params, 'planSummary')
    ? (params.planSummary ?? null)
    : parseProjectTransferPlanSummary(current.planSummaryJson)
}

const transitionProjectTransferSessionState = async (params: TransitionProjectTransferSessionStateParams) => {
  const runner = getRunner(params.runner)
  const current = await getProjectTransferSessionRecord(runner, params.sessionId)

  if (!current) {
    return null
  }

  assertSessionStateForDirection(current.direction, params.nextState)
  assertWriterOnlyStateOwnerToken(params.nextState, params.expectedOwnerToken)
  assertReadyToCommitPlan(params.nextState, getPlanSummaryForTransitionValidation(params, current))
  assertProgressUpdate({next: params.progress, previous: parseProjectTransferProgressPayload(current.progressJson)})

  const currentNow = getNow(params.now)
  const optionalConditions = getOptionalConditionsSql([
    getPlanRevisionCondition(params.expectedPlanRevision),
    getOwnerTokenCondition(params.expectedOwnerToken),
  ])
  const [row] = await runner.queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET ${getTransitionUpdateSets(params, currentNow).join(',\n      ')}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND ${getStateCondition(params.expectedState)}
      ${optionalConditions.length > 0 ? `AND ${optionalConditions}` : ''}
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const updateProjectTransferSessionPlanRevision = async (params: UpdateProjectTransferSessionPlanParams) => {
  const runner = getRunner(params.runner)
  const current = await getProjectTransferSessionRecord(runner, params.sessionId)

  if (!current) {
    return null
  }

  const nextState = params.nextState ?? current.state
  assertSessionStateForDirection(current.direction, nextState)
  assertReadyToCommitPlan(nextState, params.planSummary)

  const currentNow = getNow(params.now)
  const ownerCondition = getOwnerTokenCondition(params.expectedOwnerToken)
  const [row] = await runner.queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET
      state = ${getSqlLiteral(nextState)},
      plan_revision = plan_revision + 1,
      plan_summary_json = ${getJsonLiteral(params.planSummary)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND plan_revision = ${params.expectedPlanRevision}
      ${ownerCondition ? `AND ${ownerCondition}` : ''}
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const heartbeatProjectTransferSessionOwner = async (params: HeartbeatProjectTransferSessionOwnerParams) => {
  const currentNow = getNow(params.now)
  const expiresAt = getLeaseExpiresAt({leaseMs: params.leaseMs, now: currentNow})
  const [row] = await getRunner(params.runner).queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET
      heartbeat_at = ${getTimestampLiteral(currentNow)},
      expires_at = ${getTimestampLiteral(expiresAt)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND owner_token = ${getSqlLiteral(params.ownerToken)}
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const claimProjectTransferExportSessionOwner = async (params: ClaimProjectTransferExportSessionOwnerParams) => {
  const currentNow = getNow(params.now)
  const ownerCondition =
    params.expectedState === 'queued' ? 'owner_token IS NULL' : `owner_token = ${getSqlLiteral(params.ownerToken)}`
  const [row] = await getRunner(params.runner).queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET
      state = ${getSqlLiteral(params.nextState)},
      owner_token = ${getSqlLiteral(params.ownerToken)},
      heartbeat_at = ${getTimestampLiteral(currentNow)},
      progress_json = ${getJsonLiteral(params.progress ?? null)},
      error_json = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND direction = 'export'
      AND state = ${getSqlLiteral(params.expectedState)}
      AND ${ownerCondition}
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const heartbeatProjectTransferExportSessionOwner = async (params: HeartbeatProjectTransferExportSessionOwnerParams) => {
  const currentNow = getNow(params.now)
  const [row] = await getRunner(params.runner).queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET
      heartbeat_at = ${getTimestampLiteral(currentNow)},
      ${Object.hasOwn(params, 'progress') ? `progress_json = ${getJsonLiteral(params.progress ?? null)},` : ''}
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND direction = 'export'
      AND owner_token = ${getSqlLiteral(params.ownerToken)}
      AND state IN ('assembling', 'packaging')
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const failProjectTransferSessionExport = async (params: FailProjectTransferSessionExportParams) => {
  const currentNow = getNow(params.now)
  const [row] = await getRunner(params.runner).queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET
      state = 'failed',
      owner_token = NULL,
      progress_json = ${getJsonLiteral(params.progress ?? null)},
      error_json = ${getJsonLiteral(params.error)},
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND direction = 'export'
      AND state IN ('assembling', 'packaging')
      AND owner_token = ${getSqlLiteral(params.ownerToken)}
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const updateProjectTransferSessionProgress = async (params: UpdateProjectTransferSessionProgressParams) => {
  const work = async (runner: ProjectTransferSessionRunner) => {
    const current = await getProjectTransferSessionRecord(runner, params.sessionId)

    if (!current) {
      return null
    }

    assertProgressUpdate({next: params.progress, previous: parseProjectTransferProgressPayload(current.progressJson)})

    const ownerCondition = getOwnerTokenCondition(params.expectedOwnerToken)
    const currentNow = getNow(params.now)
    const [row] = await runner.queryJson<
      Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
        completionPayloadJson: unknown
        errorJson: unknown
        planSummaryJson: unknown
        progressJson: unknown
      }
    >(`
      UPDATE app.project_transfer_session
      SET
        progress_json = ${getJsonLiteral(params.progress)},
        updated_at = ${getTimestampLiteral(currentNow)}
      WHERE id = ${getSqlLiteral(params.sessionId)}
        ${ownerCondition ? `AND ${ownerCondition}` : ''}
      RETURNING ${getProjectTransferSessionSelectSql()}
    `)

    return row ? mapProjectTransferSessionRecord(row) : null
  }

  return params.runner
    ? work(params.runner)
    : (getAppDatabaseService().transaction(work) as Promise<ProjectTransferSessionRecord | null>)
}

const persistProjectTransferSessionCompletion = async (params: PersistProjectTransferSessionCompletionParams) => {
  if (params.completionPayload.status !== 'completed') {
    throw new Error('Project transfer completion payload status must be completed')
  }

  return transitionProjectTransferSessionState({
    completionPayload: params.completionPayload,
    expectedOwnerToken: params.ownerToken,
    expectedPlanRevision: params.expectedPlanRevision,
    expectedState: ['committing', 'ready_to_commit'],
    nextOwnerToken: null,
    nextState: 'completed',
    now: params.now,
    runner: params.runner,
    sessionId: params.sessionId,
  })
}

const persistProjectTransferSessionExportReady = async (params: PersistProjectTransferSessionExportReadyParams) => {
  if (params.completionPayload.status !== 'ready') {
    throw new Error('Project transfer export readiness payload status must be ready')
  }

  const currentNow = getNow(params.now)
  const [row] = await getRunner(params.runner).queryJson<
    Omit<ProjectTransferSessionRecord, 'completionPayloadJson' | 'errorJson' | 'planSummaryJson' | 'progressJson'> & {
      completionPayloadJson: unknown
      errorJson: unknown
      planSummaryJson: unknown
      progressJson: unknown
    }
  >(`
    UPDATE app.project_transfer_session
    SET
      state = 'ready',
      owner_token = NULL,
      package_fingerprint = ${getSqlLiteral(params.completionPayload.packageFingerprint)},
      completion_payload_json = ${getJsonLiteral(params.completionPayload)},
      progress_json = ${getJsonLiteral(params.progress ?? null)},
      error_json = NULL,
      updated_at = ${getTimestampLiteral(currentNow)}
    WHERE id = ${getSqlLiteral(params.sessionId)}
      AND direction = 'export'
      AND state = 'packaging'
      AND owner_token = ${getSqlLiteral(params.ownerToken)}
    RETURNING ${getProjectTransferSessionSelectSql()}
  `)

  return row ? mapProjectTransferSessionRecord(row) : null
}

const projectTransferSessionRepository = {
  claimProjectTransferExportSessionOwner,
  createProjectTransferSession,
  failProjectTransferSessionExport,
  getProjectTransferSession,
  heartbeatProjectTransferExportSessionOwner,
  heartbeatProjectTransferSessionOwner,
  persistProjectTransferSessionExportReady,
  persistProjectTransferSessionCompletion,
  transitionProjectTransferSessionState,
  updateProjectTransferSessionPlanRevision,
  updateProjectTransferSessionProgress,
}

export const getProjectTransferSessionRepository = () => {
  return projectTransferSessionRepository
}

export type {
  ClaimProjectTransferExportSessionOwnerParams,
  CreateProjectTransferSessionParams,
  FailProjectTransferSessionExportParams,
  GetProjectTransferSessionParams,
  HeartbeatProjectTransferExportSessionOwnerParams,
  HeartbeatProjectTransferSessionOwnerParams,
  PersistProjectTransferSessionCompletionParams,
  PersistProjectTransferSessionExportReadyParams,
  ProjectTransferSessionRunner,
  TransitionProjectTransferSessionStateParams,
  UpdateProjectTransferSessionPlanParams,
  UpdateProjectTransferSessionProgressParams,
}

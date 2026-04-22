import {Elysia, t} from 'elysia'

import {getUnassessedArticlesFromOlap, getUnassessedCountFromOlap} from '../../services/olap/unassessedArticlesOlap.ts'
import {getJudgmentDispatchProviderStats} from '../cron/judgmentsJobs/judgmentDispatchRuntime.ts'
import {
  getJudgmentEndpointAvailability,
  getJudgmentEndpointAvailabilityDiagnostics,
} from '../cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import {runJudgmentJobRepairAction} from '../cron/judgmentsJobs/judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from '../cron/judgmentsJobs/judgmentJobServerIdentity.ts'
import {
  isJudgmentJobSqliteIsolatedImportLeaseConflict,
  runJudgmentJobSqliteIsolatedFlush,
} from '../cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts'
import {flushJudgmentJobSqliteOutbox} from '../cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts'
import {assertJudgmentJobCanRunSqlitePreflight} from '../cron/judgmentsJobs/judgmentJobSqlitePreflight.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {
  getJudgmentJobRepairMode,
  getJudgmentJobStartupHandling,
  hasJudgmentJobLocalSqliteState,
} from '../cron/judgmentsJobs/judgmentJobStoragePolicy.ts'
import {getJudgmentJobStorageTransferRuntime} from '../cron/judgmentsJobs/judgmentJobStorageTransferRuntime.ts'
import {getEffectiveProviderCap} from '../cron/judgmentsJobs/judgmentsJobsSendToLLM.ts'
import {getJudgmentRequestStats} from '../cron/judgmentsJobs/judgmentsRequestRuntime.ts'
import {getProviderConnectionForStoredModel} from '../providers/providerConnectionRepository.ts'
import {assertStoredProviderModelRuntimeMatch} from '../providers/providerRuntimeModelGuard.ts'
import {getProviderConnectionEffectiveBaseURL} from '../providers/providerRuntimeState.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
} from '../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../services/appReadOnlyDatabaseService.ts'
import {deleteJudgmentJobSafelyTx} from '../services/judgmentJobDeleteService.ts'
import {
  getJudgmentJobSqliteHealthProjectionService,
  type JudgmentJobSqliteHealthProjectionReader,
  type JudgmentJobSqliteHealthProjectionRecord,
  type JudgmentJobSqliteHealthSnapshotForProjection,
} from '../services/judgmentJobSqliteHealthProjectionService.ts'
import {getDuckdbOwnerConnectionsOverview} from '../utils/duckdbOwnerConnections.ts'
import {HttpError} from '../utils/httpError.ts'
import {getProjectMartLargeRebuildRuntimeMetrics} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {getCurrentServerRole, shouldCurrentServerRunJudgingLoops} from '../utils/serverRuntimeRole.ts'

type TokenUsageDaySummary = {
  date: string
  dailyTokens: number
  dailyPromptTokens: number
  dailyCompletionTokens: number
  requests: number
}

const judgmentJobServerId = getDefaultJudgmentServerJobId()

type JudgmentJobMutationState = {
  error: unknown
  id: string
  status: string
  storageState: string
  quarantinedAt: unknown
  quarantineReason: string | null
  lastImportStartedAt: unknown
  lastImportCompletedAt: unknown
  lastImportErrorAt: unknown
  lastImportError: string | null
  lastImportExitCode: number | null
  importFailureCount: number | null
  pauseRequestedAt: unknown
  updatedAt: unknown
}
type JudgmentJobMutationQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}
type JudgmentJobSqliteHealthSnapshot = JudgmentJobSqliteHealthSnapshotForProjection & {
  healthProjection?: {freshUntilAt: Date; projectedAt: Date; projectedBy: string | null; source: string}
}
type JudgmentJobHealthAction =
  | 'none'
  | 'repair_offline_required'
  | 'repair_missing_sqlite'
  | 'repair_orphaned_queue'
  | 'wait_for_drain'
  | 'repair_quarantine'
  | 'resume_outbox_import'
  | 'retry_stale_import'
type JudgmentJobHealthBadge =
  | 'Healthy'
  | 'Draining'
  | 'Large WAL'
  | 'Offline Repair'
  | 'Quarantined'
  | 'Retained Outbox'
  | 'Stale Import'
type UnassessedCountCacheValue = {value: number; expiresAt: number}
type ProjectMartFreshnessState = {dirtyToken: number | null; isFresh: boolean; lastCompletedRefreshToken: number | null}
type JudgmentJobStorageProjection = {
  activeLargeRebuildProjectCount: number
  currentPhase: string | null
  estimatedCurrentPhaseRemainingMs: number | null
  estimatedStorageDrainRemainingMs: number | null
  projectedStorageDrainAt: string | null
  remainingCurrentPhaseArticleCount: number | null
  rowsPerMinute: number | null
  scopeArticleCount: number | null
}
type FailedRequestDetailRecord = Record<string, unknown>
type FailedRequestSummary = {
  anthropicRefusalArticles: number
  anthropicRefusals: number
  persistedFailedRequests: number
}
type JudgmentJobBlockedReason =
  | 'endpoint_circuit_breaker'
  | 'endpoint_cooldown'
  | 'endpoint_misconfigured'
  | 'stale_import'
  | 'storage_repair_required'
  | 'waiting_for_judge_worker'
  | 'waiting_for_owner_ack'
  | null
type JudgmentJobProgressState =
  | 'active_import'
  | 'blocked_import'
  | 'completed'
  | 'cooldown'
  | 'idle'
  | 'processing'
  | 'queued'
  | 'repair_required'
  | 'waiting_for_owner_ack'
type JudgmentJobWorkIdentity = {
  modelId: string
  projectId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type JudgmentJobImportConsumerAvailability = {
  eligibleConsumerCount: number
  eligibleConsumerPresent: boolean
  freshConsumerCount: number
  freshConsumerPresent: boolean
  registeredConsumerCount: number
  requiredConsumerRole: 'judge-worker'
  staleConsumerCount: number
}
type JudgmentJobImportWorkLease = {
  consumerId: string | null
  freshUntilAt: string | null
  lastProgressedAt: string | null
  lastStartedAt: string | null
  recoveryContext: Record<string, unknown> | null
  recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
  retryAfterAt: string | null
}
type JudgmentJobEndpointHealth = {
  diagnostics: ReturnType<typeof getJudgmentEndpointAvailabilityDiagnostics> | null
  retryAfterAt: string | null
}
type JudgmentJobHealthProgress = {
  activeConsumerCount: number
  activeImportWorkCount: number
  blockedReason: JudgmentJobBlockedReason
  importBacklogCount: number
  importConsumer: JudgmentJobImportConsumerAvailability
  importWork: {
    activeConsumerCount: number
    activeWorkCount: number
    claimedOutboxCount: number
    hasBacklog: boolean
    outboxRowCount: number
    pendingCompletionAckCount: number
    workIdentity: JudgmentJobWorkIdentity
  }
  lastProgressedAt: string | null
  lastStartedAt: string | null
  progressState: JudgmentJobProgressState
  recoveryContext: Record<string, unknown> | null
  recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
  retryAfterAt: string | null
  runningWork: {
    activePromptCount: number
    claimedPromptCount: number
    judgedPromptCount: number
    readyPromptCount: number
    runningPromptCount: number
    skippedPromptCount: number
    workIdentity: JudgmentJobWorkIdentity
  }
  workIdentity: JudgmentJobWorkIdentity
}
const unassessedCountTTLms = 10_000
const staleImportThresholdMs = 15 * 60 * 1_000
const largeWalThresholdBytes = 64 * 1_024 * 1_024
const unassessedCountCache = new Map<string, UnassessedCountCacheValue>()
const articleScopedLargeRebuildPhases = new Set([
  'prompt_answer_fact',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
])
const systemSqliteFallbackStepsSchema = t.Array(
  t.Union([t.Literal('checkpoint'), t.Literal('diagnostic'), t.Literal('export')]),
)

const getJudgmentJobsReadDatabase = (): JudgmentJobSqliteHealthProjectionReader => {
  return getCurrentServerRole() === 'api' ? getApiReadOnlyAppDatabaseService() : getAppDatabaseService()
}

const getMaintenanceUnavailableError = (message: string, cause?: unknown) => {
  return new HttpError(503, `maintenance-unavailable: ${message}`, {cause})
}

const runJudgmentJobsRead = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }

    if (getCurrentServerRole() === 'api') {
      throw getMaintenanceUnavailableError('judgment job read model is unavailable', error)
    }

    throw error
  }
}

const getUnassessedCountCacheKey = (
  projectId: string,
  projectModelId: string,
  projectDateFrom: Date | null | undefined,
  projectDateTo: Date | null | undefined,
  importRouteIds: string[],
  useTitle: boolean,
  useAbstract: boolean,
  useFulltext: boolean,
  useFulltextNoImages: boolean,
  dirtyToken: number | null,
  lastCompletedRefreshToken: number | null,
) => {
  const from = projectDateFrom ? projectDateFrom.toISOString() : ''
  const to = projectDateTo ? projectDateTo.toISOString() : ''
  const routes = importRouteIds.slice().sort().join(',')
  const content = `${useTitle}|${useAbstract}|${useFulltext}|${useFulltextNoImages}`
  return `${projectId}|${projectModelId}|${from}|${to}|${routes}|${content}|${dirtyToken ?? 'null'}|${lastCompletedRefreshToken ?? 'null'}`
}

const getProjectMartFreshnessState = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<ProjectMartFreshnessState> => {
  const [row] = await db.queryJson<{dirtyToken: number | null; lastCompletedRefreshToken: number | null}>(`
    SELECT
      CAST(dirty_token AS INTEGER) AS dirtyToken,
      CAST(last_completed_refresh_token AS INTEGER) AS lastCompletedRefreshToken
    FROM app.project_mart_refresh_state
    WHERE project_id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)
  const dirtyToken = row?.dirtyToken ?? null
  const lastCompletedRefreshToken = row?.lastCompletedRefreshToken ?? null

  return {
    dirtyToken,
    isFresh: dirtyToken === null || (lastCompletedRefreshToken !== null && lastCompletedRefreshToken >= dirtyToken),
    lastCompletedRefreshToken,
  }
}

const getProjectLargeRebuildRowsPerMs = (projectId: string) => {
  const cycles = getProjectMartLargeRebuildRuntimeMetrics()
    .recentCycles.filter((cycle) => {
      return cycle.projectId === projectId && cycle.status === 'progressed' && cycle.articleCount > 0
    })
    .slice(-12)

  if (cycles.length === 0) {
    return null
  }

  const totalRows = cycles.reduce((sum, cycle) => {
    return sum + cycle.articleCount
  }, 0)

  if (totalRows <= 0) {
    return null
  }

  const firstStartedAt = new Date(cycles[0]?.startedAt ?? '').getTime()
  const lastEndedAt = new Date(cycles[cycles.length - 1]?.endedAt ?? '').getTime()
  const totalDurationMs = cycles.reduce((sum, cycle) => {
    return sum + cycle.durationMs
  }, 0)
  const elapsedMs =
    Number.isFinite(firstStartedAt) && Number.isFinite(lastEndedAt)
      ? Math.max(lastEndedAt - firstStartedAt, totalDurationMs, 1)
      : Math.max(totalDurationMs, 1)

  return totalRows / elapsedMs
}

const getEstimatedRemainingArticlePassCount = ({
  currentPhase,
  remainingCurrentPhaseArticleCount,
  scopeArticleCount,
}: {
  currentPhase: string | null
  remainingCurrentPhaseArticleCount: number | null
  scopeArticleCount: number
}) => {
  if (currentPhase === 'prompt_answer_fact') {
    return (remainingCurrentPhaseArticleCount ?? scopeArticleCount) + scopeArticleCount * 3
  }

  if (currentPhase === 'review_answer_dictionary') {
    return scopeArticleCount * 3
  }

  if (currentPhase === 'review_article_filter_member') {
    return (remainingCurrentPhaseArticleCount ?? scopeArticleCount) + scopeArticleCount * 2
  }

  if (currentPhase === 'review_article_rollup') {
    return (remainingCurrentPhaseArticleCount ?? scopeArticleCount) + scopeArticleCount
  }

  if (currentPhase === 'review_article_serving') {
    return remainingCurrentPhaseArticleCount ?? scopeArticleCount
  }

  return null
}

const getJudgmentJobStorageProjection = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<JudgmentJobStorageProjection | null> => {
  const [rebuildRow] = await db.queryJson<{
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    rebuildPhase: string | null
    refreshToken: number | null
  }>(`
    SELECT
      cursor_article_created_at AS cursorArticleCreatedAt,
      cursor_article_id AS cursorArticleId,
      rebuild_phase AS rebuildPhase,
      CAST(refresh_token AS INTEGER) AS refreshToken
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  if ((rebuildRow?.refreshToken ?? 0) <= 0) {
    return null
  }

  const [activeCountRows, scopeCountRows] = await Promise.all([
    db.queryJson<{activeLargeRebuildProjectCount: number}>(`
      SELECT CAST(COUNT(*) AS INTEGER) AS activeLargeRebuildProjectCount
      FROM app.project_mart_large_rebuild_state
      WHERE refresh_token > 0
    `),
    db.queryJson<{remainingCurrentPhaseArticleCount: number; scopeArticleCount: number}>(`
      WITH route_scope AS (
        SELECT
          pir.project_id,
          air.article_id,
          TRUE AS in_route_scope,
          FALSE AS in_curated_scope
        FROM app.project_import_route pir
        INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
        WHERE pir.project_id = ${getSqlLiteral(projectId)}
      ),
      curated_scope AS (
        SELECT
          pa.project_id,
          pa.article_id,
          FALSE AS in_route_scope,
          TRUE AS in_curated_scope
        FROM app.project_article pa
        WHERE pa.project_id = ${getSqlLiteral(projectId)}
      ),
      combined_scope AS (
        SELECT * FROM route_scope
        UNION ALL
        SELECT * FROM curated_scope
      ),
      aggregated_scope AS (
        SELECT project_id, article_id
        FROM combined_scope
        GROUP BY project_id, article_id
      )
      SELECT
        CAST(COUNT(*) AS INTEGER) AS scopeArticleCount,
        CAST(
          COALESCE(
            SUM(
              CASE
                WHEN ${getSqlLiteral(rebuildRow.cursorArticleId)} IS NULL THEN 1
                WHEN COALESCE(article.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') > COALESCE(${getSqlLiteral(rebuildRow.cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') THEN 1
                WHEN COALESCE(article.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') = COALESCE(${getSqlLiteral(rebuildRow.cursorArticleCreatedAt)}, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')
                  AND aggregated_scope.article_id > ${getSqlLiteral(rebuildRow.cursorArticleId)} THEN 1
                ELSE 0
              END
            ),
            0
          ) AS INTEGER
        ) AS remainingCurrentPhaseArticleCount
      FROM aggregated_scope
      INNER JOIN app.article article ON article.id = aggregated_scope.article_id
    `),
  ])

  const scopeArticleCount = scopeCountRows[0]?.scopeArticleCount ?? 0
  const remainingCurrentPhaseArticleCount = articleScopedLargeRebuildPhases.has(rebuildRow.rebuildPhase ?? '')
    ? (scopeCountRows[0]?.remainingCurrentPhaseArticleCount ?? scopeArticleCount)
    : null
  const rowsPerMs = getProjectLargeRebuildRowsPerMs(projectId)
  const estimatedCurrentPhaseRemainingMs =
    rowsPerMs !== null && remainingCurrentPhaseArticleCount !== null
      ? Math.round(remainingCurrentPhaseArticleCount / rowsPerMs)
      : null
  const estimatedRemainingArticlePassCount = getEstimatedRemainingArticlePassCount({
    currentPhase: rebuildRow.rebuildPhase,
    remainingCurrentPhaseArticleCount,
    scopeArticleCount,
  })
  const estimatedStorageDrainRemainingMs =
    rowsPerMs !== null && estimatedRemainingArticlePassCount !== null
      ? Math.round(estimatedRemainingArticlePassCount / rowsPerMs)
      : null

  return {
    activeLargeRebuildProjectCount: activeCountRows[0]?.activeLargeRebuildProjectCount ?? 0,
    currentPhase: rebuildRow.rebuildPhase,
    estimatedCurrentPhaseRemainingMs,
    estimatedStorageDrainRemainingMs,
    projectedStorageDrainAt:
      estimatedStorageDrainRemainingMs === null
        ? null
        : new Date(Date.now() + estimatedStorageDrainRemainingMs).toISOString(),
    remainingCurrentPhaseArticleCount,
    rowsPerMinute: rowsPerMs === null ? null : Math.round(rowsPerMs * 60 * 1000),
    scopeArticleCount,
  }
}

const getUtcDayKey = (value: Date) => {
  return value.toISOString().slice(0, 10)
}

const aggregateTokenUsagePerDay = (
  rows: Array<{
    createdAt: Date
    dailyTokens: number | string | null
    dailyPromptTokens: number | string | null
    dailyCompletionTokens: number | string | null
    requests: number | string | null
  }>,
): TokenUsageDaySummary[] => {
  const dailyMap = rows.reduce<Map<string, TokenUsageDaySummary>>((map, row) => {
    const dayKey = getUtcDayKey(row.createdAt)
    const current = map.get(dayKey) ?? {
      date: `${dayKey}T00:00:00.000Z`,
      dailyTokens: 0,
      dailyPromptTokens: 0,
      dailyCompletionTokens: 0,
      requests: 0,
    }

    map.set(dayKey, {
      ...current,
      dailyTokens: current.dailyTokens + Number(row.dailyTokens ?? 0),
      dailyPromptTokens: current.dailyPromptTokens + Number(row.dailyPromptTokens ?? 0),
      dailyCompletionTokens: current.dailyCompletionTokens + Number(row.dailyCompletionTokens ?? 0),
      requests: current.requests + Number(row.requests ?? 0),
    })

    return map
  }, new Map<string, TokenUsageDaySummary>())

  return Array.from(dailyMap.entries())
    .sort((left, right) => {
      return left[0].localeCompare(right[0])
    })
    .map(([, value]) => {
      return value
    })
}

const getJobContext = async ({
  db = getAppDatabaseService(),
  jobId,
}: {
  db?: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<{
  job: {
    id: string
    createdAt: Date
    updatedAt: Date
    projectId: string
    status: string
    error: string[] | null
    storageState: string
    quarantinedAt: Date | null
    quarantineReason: string | null
    lastImportStartedAt: Date | null
    lastImportCompletedAt: Date | null
    lastImportErrorAt: Date | null
    lastImportError: string | null
    lastImportExitCode: number | null
    importFailureCount: number
    pauseRequestedAt: Date | null
    projectName: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }
  projectModelId: string
  projectDateFrom: Date | null
  projectDateTo: Date | null
  importRouteIds: string[]
}> => {
  const [jobWithProject, projectImportRoutes] = await Promise.all([
    db.queryJson<{
      id: string
      createdAt: unknown
      updatedAt: unknown
      projectId: string
      status: string
      error: unknown
      storageState: string
      quarantinedAt: unknown
      quarantineReason: string | null
      lastImportStartedAt: unknown
      lastImportCompletedAt: unknown
      lastImportErrorAt: unknown
      lastImportError: string | null
      lastImportExitCode: number | null
      importFailureCount: number | null
      pauseRequestedAt: unknown
      projectName: string | null
      projectModelId: string | null
      projectDateFrom: unknown
      projectDateTo: unknown
      projectUseTitle: boolean | null
      projectUseAbstract: boolean | null
      projectUseFulltext: boolean | null
      projectUseFulltextNoImages: boolean | null
    }>(`
      SELECT
        jj.id AS id,
        jj.created_at AS createdAt,
        jj.updated_at AS updatedAt,
        jj.project_id AS projectId,
        jj.status AS status,
        TO_JSON(jj.error) AS error,
        jj.storage_state AS storageState,
        jj.quarantined_at AS quarantinedAt,
        jj.quarantine_reason AS quarantineReason,
        jj.last_import_started_at AS lastImportStartedAt,
        jj.last_import_completed_at AS lastImportCompletedAt,
        jj.last_import_error_at AS lastImportErrorAt,
        jj.last_import_error AS lastImportError,
        jj.last_import_exit_code AS lastImportExitCode,
        jj.import_failure_count AS importFailureCount,
        jj.pause_requested_at AS pauseRequestedAt,
        p.name AS projectName,
        p.model_id AS projectModelId,
        p.date_from AS projectDateFrom,
        p.date_to AS projectDateTo,
        p.use_title AS projectUseTitle,
        p.use_abstract AS projectUseAbstract,
        p.use_fulltext AS projectUseFulltext,
        p.use_fulltext_no_images AS projectUseFulltextNoImages
      FROM app.judgment_job jj
      LEFT JOIN app.project p ON jj.project_id = p.id
      WHERE jj.id = '${escapeSqlString(jobId)}'
      LIMIT 1
    `),
    db.queryJson<{importRouteId: string}>(`
      SELECT pir.import_route_id AS importRouteId
      FROM app.project_import_route pir
      INNER JOIN app.judgment_job jj ON jj.project_id = pir.project_id
      WHERE jj.id = '${escapeSqlString(jobId)}'
    `),
  ]).then(([jobRows, routeRows]) => {
    return [jobRows[0], routeRows] as const
  })

  if (!jobWithProject) {
    throw new Error('Job not found')
  }

  const {
    projectDateFrom,
    projectDateTo,
    projectModelId,
    projectUseTitle,
    projectUseAbstract,
    projectUseFulltext,
    projectUseFulltextNoImages,
    ...rest
  } = jobWithProject

  const job = {
    ...rest,
    createdAt: getDateValue(rest.createdAt) ?? new Date(0),
    updatedAt: getDateValue(rest.updatedAt) ?? new Date(0),
    error: getJsonValue(rest.error) as string[] | null,
    storageState: rest.storageState,
    quarantinedAt: getDateValue(rest.quarantinedAt),
    quarantineReason: rest.quarantineReason,
    lastImportStartedAt: getDateValue(rest.lastImportStartedAt),
    lastImportCompletedAt: getDateValue(rest.lastImportCompletedAt),
    lastImportErrorAt: getDateValue(rest.lastImportErrorAt),
    lastImportError: rest.lastImportError,
    lastImportExitCode: rest.lastImportExitCode,
    importFailureCount: Number(rest.importFailureCount ?? 0),
    pauseRequestedAt: getDateValue(rest.pauseRequestedAt),
    useTitle: projectUseTitle ?? true,
    useAbstract: projectUseAbstract ?? true,
    useFulltext: projectUseFulltext ?? false,
    useFulltextNoImages: projectUseFulltextNoImages ?? false,
  }

  if (!projectModelId) {
    throw new Error('Project model ID not found')
  }

  return {
    job,
    projectModelId,
    projectDateFrom: getDateValue(projectDateFrom),
    projectDateTo: getDateValue(projectDateTo),
    importRouteIds: projectImportRoutes.map((r) => {
      return r.importRouteId
    }),
  }
}

const getProjectModelId = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<string> => {
  const [project] = await db.queryJson<{modelId: string | null}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  if (!project?.modelId) {
    throw new HttpError(400, 'Project model ID not found')
  }

  return project.modelId
}

const isImportInFlight = (job: {lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}) => {
  const startedAt = job.lastImportStartedAt
  const completedAt = job.lastImportCompletedAt

  return Boolean(startedAt && (!completedAt || completedAt < startedAt))
}

const isStaleImportJob = (
  job: {lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null},
  now = Date.now(),
) => {
  const startedAt = job.lastImportStartedAt

  return Boolean(startedAt && isImportInFlight(job) && now - startedAt.getTime() >= staleImportThresholdMs)
}

const getProjectedSqliteHealth = (
  projection: JudgmentJobSqliteHealthProjectionRecord,
): JudgmentJobSqliteHealthSnapshot => {
  return {
    claimedOutboxCount: projection.claimedOutboxCount,
    hasOutboxRows: projection.hasOutboxRows,
    hasPendingCompletionAck: projection.hasPendingCompletionAck,
    hasQueueRows: projection.hasQueueRows,
    lastAckSeq: projection.lastAckSeq,
    oldestUnackedCompletionAgeMs: projection.oldestUnackedCompletionAgeMs,
    oldestUnexportedAgeMs: projection.oldestUnexportedAgeMs,
    orphanedJudgedRowCount: projection.orphanedJudgedRowCount,
    outboxRowCount: projection.outboxRowCount,
    pendingCompletionAckCount: projection.pendingCompletionAckCount,
    healthProjection: {
      freshUntilAt: projection.freshUntilAt,
      projectedAt: projection.projectedAt,
      projectedBy: projection.projectedBy,
      source: projection.projectionSource,
    },
    promptCounts: projection.promptCounts,
    retainedRowCount: projection.retainedRowCount,
    sqliteFileBytes: projection.sqliteFileBytes,
    walBytes: projection.walBytes,
  }
}

const getSqliteHealthFromFreshProjection = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<JudgmentJobSqliteHealthSnapshot> => {
  const projection = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjection({
    db,
    jobId,
  })

  if (!projection) {
    throw getMaintenanceUnavailableError(`fresh SQLite health projection is unavailable for judgment job ${jobId}`)
  }

  return getProjectedSqliteHealth(projection)
}

const getSqliteHealthForReadableRoute = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<JudgmentJobSqliteHealthSnapshot> => {
  return shouldCurrentServerRunJudgingLoops()
    ? getJudgmentJobSqliteService().getHealthSnapshot(jobId)
    : getSqliteHealthFromFreshProjection({db, jobId})
}

const getSqliteHealthMapForReadableRoute = async ({
  db,
  jobIds,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobIds: string[]
}) => {
  if (shouldCurrentServerRunJudgingLoops()) {
    const entries = await Promise.all(
      jobIds.map(async (jobId) => {
        return [jobId, await getJudgmentJobSqliteService().getHealthSnapshot(jobId)] as const
      }),
    )

    return new Map(entries)
  }

  const projections = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjections({
    db,
    jobIds,
  })
  const missingJobIds = jobIds.filter((jobId) => {
    return !projections.has(jobId)
  })

  if (missingJobIds.length > 0) {
    throw getMaintenanceUnavailableError(
      `fresh SQLite health projection is unavailable for judgment jobs ${missingJobIds.join(', ')}`,
    )
  }

  return new Map(
    Array.from(projections.entries()).map(([jobId, projection]) => {
      return [jobId, getProjectedSqliteHealth(projection)] as const
    }),
  )
}

const hasRetainedOutbox = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.outboxRowCount > 0 || sqliteHealth.claimedOutboxCount > 0
}

const hasOrphanedJudgedQueue = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.orphanedJudgedRowCount > 0
}

const hasLargeWal = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.walBytes >= largeWalThresholdBytes
}

const getStoragePolicy = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}) => {
  const hasLocalSqliteState = hasJudgmentJobLocalSqliteState(sqliteHealth)

  return {
    hasLocalSqliteState,
    repairMode: getJudgmentJobRepairMode({hasLocalSqliteState, job}),
    startupHandling: getJudgmentJobStartupHandling({hasLocalSqliteState, job}),
  }
}

const getJobHealthBadges = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}): JudgmentJobHealthBadge[] => {
  const badges: JudgmentJobHealthBadge[] = []
  const storagePolicy = getStoragePolicy({job, sqliteHealth})

  if (storagePolicy.repairMode === 'offline_repair_required') {
    badges.push('Offline Repair')
  }

  if (job.storageState === 'quarantined') {
    badges.push('Quarantined')
  }

  if (job.storageState === 'draining') {
    badges.push('Draining')
  }

  if (isStaleImportJob(job)) {
    badges.push('Stale Import')
  }

  if (hasRetainedOutbox(sqliteHealth)) {
    badges.push('Retained Outbox')
  }

  if (hasLargeWal(sqliteHealth)) {
    badges.push('Large WAL')
  }

  return badges.length > 0 ? badges : ['Healthy']
}

const getRecommendedHealthAction = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}): JudgmentJobHealthAction => {
  const storagePolicy = getStoragePolicy({job, sqliteHealth})

  if (storagePolicy.repairMode === 'offline_repair_required') {
    return 'repair_offline_required'
  }

  if (job.storageState === 'quarantined') {
    return 'repair_quarantine'
  }

  if (job.storageState === 'missing') {
    return 'repair_missing_sqlite'
  }

  if (isStaleImportJob(job)) {
    return 'retry_stale_import'
  }

  if (hasOrphanedJudgedQueue(sqliteHealth)) {
    return 'repair_orphaned_queue'
  }

  if (job.storageState === 'draining') {
    return 'wait_for_drain'
  }

  if (hasRetainedOutbox(sqliteHealth)) {
    return 'resume_outbox_import'
  }

  return 'none'
}

const isHealthyJob = ({action, job}: {action: JudgmentJobHealthAction; job: {storageState: string}}) => {
  return job.storageState === 'active' && action === 'none'
}

const assertProjectRuntimeModelMatch = async (projectId: string): Promise<void> => {
  const projectModelId = await getProjectModelId(projectId)

  return assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
}

const getJudgingRuntimeReason = (): string | null => {
  return !shouldCurrentServerRunJudgingLoops()
    ? 'This server is not configured for judging loops, so it cannot process queued prompts.'
    : null
}

const getJudgingRuntime = (): {enabled: boolean; reason: string | null} => {
  const reason = getJudgingRuntimeReason()
  return {enabled: reason === null, reason}
}

const assertJudgingRuntimeCanRun = (): void => {
  const reason = getJudgingRuntimeReason()

  if (reason) {
    throw new HttpError(400, reason)
  }
}

const getIsoDateString = (value: unknown): string | null => {
  return getDateValue(value)?.toISOString() ?? null
}

const getJudgmentJobWorkIdentity = ({
  job,
  modelId,
}: {
  job: {projectId: string; useAbstract: boolean; useFulltext: boolean; useFulltextNoImages: boolean; useTitle: boolean}
  modelId: string
}): JudgmentJobWorkIdentity => {
  return {
    modelId,
    projectId: job.projectId,
    useAbstract: job.useAbstract,
    useFulltext: job.useFulltext,
    useFulltextNoImages: job.useFulltextNoImages,
    useTitle: job.useTitle,
  }
}

const getJudgmentImportConsumerAvailability = async (): Promise<JudgmentJobImportConsumerAvailability> => {
  const registry = (await getDuckdbOwnerConnectionsOverview()).registry
  const judging = registry.capabilities.find((capability) => {
    return capability.capability === 'judging'
  })
  const localJudgingConsumerCount = shouldCurrentServerRunJudgingLoops() ? 1 : 0
  const eligibleConsumerCount = Math.max(judging?.eligibleConsumerCount ?? 0, localJudgingConsumerCount)
  const freshConsumerCount = Math.max(judging?.freshConsumerCount ?? 0, localJudgingConsumerCount)
  const registeredConsumerCount = Math.max(judging?.registeredConsumerCount ?? 0, localJudgingConsumerCount)

  return {
    eligibleConsumerCount,
    eligibleConsumerPresent: eligibleConsumerCount > 0,
    freshConsumerCount,
    freshConsumerPresent: freshConsumerCount > 0,
    registeredConsumerCount,
    requiredConsumerRole: 'judge-worker',
    staleConsumerCount: judging?.staleConsumerCount ?? 0,
  }
}

const getJudgmentImportWorkLeasesByJobId = async ({
  db,
  jobIds,
  now,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobIds: string[]
  now: Date
}): Promise<Map<string, JudgmentJobImportWorkLease[]>> => {
  if (jobIds.length === 0) {
    return new Map()
  }

  const rows = await db.queryJson<{
    consumerId: string | null
    freshUntilAt: unknown
    jobId: string
    lastProgressedAt: unknown
    lastStartedAt: unknown
    recoveryContext: unknown
    recoveryMode: JudgmentJobImportWorkLease['recoveryMode']
    retryAfterAt: unknown
  }>(`
    SELECT
      judgment_job_id AS jobId,
      consumer_id AS consumerId,
      last_started_at AS lastStartedAt,
      last_progressed_at AS lastProgressedAt,
      fresh_until_at AS freshUntilAt,
      retry_after_at AS retryAfterAt,
      recovery_mode AS recoveryMode,
      TO_JSON(recovery_context) AS recoveryContext
    FROM app.maintenance_work_lease
    WHERE work_kind = 'judgment_sqlite_outbox_import'
      AND scope_kind = 'job'
      AND judgment_job_id IN (${getQuotedStringList(jobIds).join(', ')})
      AND completed_at IS NULL
      AND (
        fresh_until_at > ${getSqlLiteral(now)}
        OR recovery_mode <> 'none'
        OR retry_after_at > ${getSqlLiteral(now)}
      )
    ORDER BY judgment_job_id ASC, fresh_until_at DESC NULLS LAST, updated_at DESC
  `)

  return rows.reduce((map, row) => {
    const lease = {
      consumerId: row.consumerId,
      freshUntilAt: getIsoDateString(row.freshUntilAt),
      lastProgressedAt: getIsoDateString(row.lastProgressedAt),
      lastStartedAt: getIsoDateString(row.lastStartedAt),
      recoveryContext: getJsonValue(row.recoveryContext) as Record<string, unknown> | null,
      recoveryMode: row.recoveryMode,
      retryAfterAt: getIsoDateString(row.retryAfterAt),
    }
    map.set(row.jobId, [...(map.get(row.jobId) ?? []), lease])
    return map
  }, new Map<string, JudgmentJobImportWorkLease[]>())
}

const getFreshImportWorkLeases = (leases: JudgmentJobImportWorkLease[], now: Date) => {
  return leases.filter((lease) => {
    const freshUntilAt = lease.freshUntilAt ? new Date(lease.freshUntilAt).getTime() : null
    return freshUntilAt !== null && freshUntilAt > now.getTime()
  })
}

const getImportRecoveryWorkLease = (
  leases: JudgmentJobImportWorkLease[],
  now: Date,
): JudgmentJobImportWorkLease | null => {
  return (
    leases.find((lease) => {
      const retryAfterAt = lease.retryAfterAt ? new Date(lease.retryAfterAt).getTime() : null
      return lease.recoveryMode !== 'none' || (retryAfterAt !== null && retryAfterAt > now.getTime())
    }) ?? null
  )
}

const getUniqueStringCount = (values: Array<string | null>) => {
  return new Set(
    values.filter((value): value is string => {
      return value !== null && value !== ''
    }),
  ).size
}

const getJudgmentJobEndpointHealth = async ({
  db,
  modelId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  modelId: string
}): Promise<JudgmentJobEndpointHealth> => {
  const providerConnection = await getProviderConnectionForStoredModel(modelId, db)
  const effectiveBaseURL = providerConnection
    ? getProviderConnectionEffectiveBaseURL({
        baseURL: providerConnection.baseURL,
        config: providerConnection.config,
        providerKind: providerConnection.providerKind,
        savedModelIds: [modelId],
      })
    : null
  const availability = effectiveBaseURL
    ? getJudgmentEndpointAvailability({effectiveBaseURL, providerConnectionId: providerConnection?.id ?? null})
    : null

  return {
    diagnostics: availability ? getJudgmentEndpointAvailabilityDiagnostics(availability) : null,
    retryAfterAt: availability?.cooldownExpiresAt?.toISOString() ?? null,
  }
}

const getEndpointBlockedReason = (endpointHealth: JudgmentJobEndpointHealth): JudgmentJobBlockedReason => {
  const diagnostics = endpointHealth.diagnostics
  const failureMessage = diagnostics?.lastFailureMessage?.toLowerCase() ?? ''

  return !diagnostics || diagnostics.status === 'healthy' || diagnostics.status === 'probing'
    ? null
    : diagnostics.status === 'misconfigured'
      ? 'endpoint_misconfigured'
      : diagnostics.lastFailureKind === 'circuit_open' || failureMessage.includes('circuit breaker')
        ? 'endpoint_circuit_breaker'
        : 'endpoint_cooldown'
}

const isRepairRequiredAction = (action: JudgmentJobHealthAction) => {
  return (
    action === 'repair_offline_required'
    || action === 'repair_missing_sqlite'
    || action === 'repair_orphaned_queue'
    || action === 'repair_quarantine'
  )
}

const getProgressState = ({
  activeImportWorkCount,
  endpointBlockedReason,
  hasActivePrompts,
  hasImportBacklog,
  hasQueuedPrompts,
  importConsumer,
  isCompletionAckBacklog,
  isStaleImport,
  job,
  repairRequired,
}: {
  activeImportWorkCount: number
  endpointBlockedReason: JudgmentJobBlockedReason
  hasActivePrompts: boolean
  hasImportBacklog: boolean
  hasQueuedPrompts: boolean
  importConsumer: JudgmentJobImportConsumerAvailability
  isCompletionAckBacklog: boolean
  isStaleImport: boolean
  job: {status: string}
  repairRequired: boolean
}): JudgmentJobProgressState => {
  return repairRequired
    ? 'repair_required'
    : activeImportWorkCount > 0
      ? 'active_import'
      : isCompletionAckBacklog
        ? 'waiting_for_owner_ack'
        : endpointBlockedReason
          ? 'cooldown'
          : isStaleImport || (hasImportBacklog && !importConsumer.eligibleConsumerPresent)
            ? 'blocked_import'
            : hasImportBacklog || hasQueuedPrompts
              ? 'queued'
              : hasActivePrompts
                ? 'processing'
                : job.status === 'completed'
                  ? 'completed'
                  : 'idle'
}

const getProgressBlockedReason = ({
  endpointBlockedReason,
  isStaleImport,
  progressState,
  repairRequired,
}: {
  endpointBlockedReason: JudgmentJobBlockedReason
  isStaleImport: boolean
  progressState: JudgmentJobProgressState
  repairRequired: boolean
}): JudgmentJobBlockedReason => {
  return repairRequired
    ? 'storage_repair_required'
    : progressState === 'waiting_for_owner_ack'
      ? 'waiting_for_owner_ack'
      : progressState === 'cooldown' && endpointBlockedReason
        ? endpointBlockedReason
        : progressState === 'blocked_import' && isStaleImport
          ? 'stale_import'
          : progressState === 'blocked_import'
            ? 'waiting_for_judge_worker'
            : null
}

const getJudgmentJobHealthProgress = ({
  endpointHealth,
  importConsumer,
  importWorkLeases,
  job,
  now,
  recommendedNextAction,
  sqliteHealth,
  workIdentity,
}: {
  endpointHealth: JudgmentJobEndpointHealth
  importConsumer: JudgmentJobImportConsumerAvailability
  importWorkLeases: JudgmentJobImportWorkLease[]
  job: {
    lastImportCompletedAt: Date | null
    lastImportErrorAt: Date | null
    lastImportStartedAt: Date | null
    status: string
  }
  now: Date
  recommendedNextAction: JudgmentJobHealthAction
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
  workIdentity: JudgmentJobWorkIdentity
}): JudgmentJobHealthProgress => {
  const activeImportLeases = getFreshImportWorkLeases(importWorkLeases, now)
  const recoveryLease = getImportRecoveryWorkLease(importWorkLeases, now)
  const activeConsumerCount = getUniqueStringCount(
    activeImportLeases.map((lease) => {
      return lease.consumerId
    }),
  )
  const importBacklogCount = sqliteHealth.outboxRowCount + sqliteHealth.claimedOutboxCount
  const activePromptCount = sqliteHealth.promptCounts.claimed + sqliteHealth.promptCounts.running
  const endpointBlockedReason = getEndpointBlockedReason(endpointHealth)
  const repairRequired = isRepairRequiredAction(recommendedNextAction)
  const progressState = getProgressState({
    activeImportWorkCount: activeImportLeases.length,
    endpointBlockedReason,
    hasActivePrompts: activePromptCount > 0,
    hasImportBacklog: importBacklogCount > 0,
    hasQueuedPrompts: sqliteHealth.promptCounts.ready > 0 || sqliteHealth.hasQueueRows,
    importConsumer,
    isCompletionAckBacklog: sqliteHealth.hasPendingCompletionAck,
    isStaleImport: isStaleImportJob(job),
    job,
    repairRequired,
  })
  const blockedReason = getProgressBlockedReason({
    endpointBlockedReason,
    isStaleImport: isStaleImportJob(job),
    progressState,
    repairRequired,
  })
  const recoveryMode =
    recoveryLease?.recoveryMode ?? (endpointBlockedReason ? ('retry_backoff' as const) : ('none' as const))

  return {
    activeConsumerCount,
    activeImportWorkCount: activeImportLeases.length,
    blockedReason,
    importBacklogCount,
    importConsumer,
    importWork: {
      activeConsumerCount,
      activeWorkCount: activeImportLeases.length,
      claimedOutboxCount: sqliteHealth.claimedOutboxCount,
      hasBacklog: importBacklogCount > 0,
      outboxRowCount: sqliteHealth.outboxRowCount,
      pendingCompletionAckCount: sqliteHealth.pendingCompletionAckCount,
      workIdentity,
    },
    lastProgressedAt:
      activeImportLeases[0]?.lastProgressedAt
      ?? recoveryLease?.lastProgressedAt
      ?? getIsoDateString(job.lastImportCompletedAt)
      ?? getIsoDateString(job.lastImportErrorAt),
    lastStartedAt:
      activeImportLeases[0]?.lastStartedAt ?? recoveryLease?.lastStartedAt ?? getIsoDateString(job.lastImportStartedAt),
    progressState,
    recoveryContext: recoveryLease?.recoveryContext ?? null,
    recoveryMode,
    retryAfterAt: recoveryLease?.retryAfterAt ?? endpointHealth.retryAfterAt,
    runningWork: {
      activePromptCount,
      claimedPromptCount: sqliteHealth.promptCounts.claimed,
      judgedPromptCount: sqliteHealth.promptCounts.judged,
      readyPromptCount: sqliteHealth.promptCounts.ready,
      runningPromptCount: sqliteHealth.promptCounts.running,
      skippedPromptCount: sqliteHealth.promptCounts.skipped,
      workIdentity,
    },
    workIdentity,
  }
}

const getProgressStateCounts = (entries: Array<{progressState: JudgmentJobProgressState}>) => {
  return entries.reduce(
    (counts, entry) => {
      return entry.progressState === 'active_import'
        ? {...counts, activeImport: counts.activeImport + 1}
        : entry.progressState === 'blocked_import'
          ? {...counts, blockedImport: counts.blockedImport + 1}
          : entry.progressState === 'completed'
            ? {...counts, completed: counts.completed + 1}
            : entry.progressState === 'cooldown'
              ? {...counts, cooldown: counts.cooldown + 1}
              : entry.progressState === 'idle'
                ? {...counts, idle: counts.idle + 1}
                : entry.progressState === 'processing'
                  ? {...counts, processing: counts.processing + 1}
                  : entry.progressState === 'queued'
                    ? {...counts, queued: counts.queued + 1}
                    : entry.progressState === 'repair_required'
                      ? {...counts, repairRequired: counts.repairRequired + 1}
                      : {...counts, waitingForOwnerAck: counts.waitingForOwnerAck + 1}
    },
    {
      activeImport: 0,
      blockedImport: 0,
      completed: 0,
      cooldown: 0,
      idle: 0,
      processing: 0,
      queued: 0,
      repairRequired: 0,
      waitingForOwnerAck: 0,
    },
  )
}

const getJudgmentJobMutationState = async (
  db: JudgmentJobMutationQueryRunner,
  jobId: string,
): Promise<JudgmentJobMutationState | null> => {
  const [job] = await db.queryJson<JudgmentJobMutationState>(`
    SELECT
      id,
      status,
      storage_state AS storageState,
      quarantined_at AS quarantinedAt,
      quarantine_reason AS quarantineReason,
      last_import_started_at AS lastImportStartedAt,
      last_import_completed_at AS lastImportCompletedAt,
      last_import_error_at AS lastImportErrorAt,
      last_import_error AS lastImportError,
      last_import_exit_code AS lastImportExitCode,
      import_failure_count AS importFailureCount,
      pause_requested_at AS pauseRequestedAt,
      updated_at AS updatedAt,
      TO_JSON(error) AS error
    FROM app.judgment_job
    WHERE id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  return job ?? null
}

const getJudgmentJobMutationStorageAssignments = (status?: string) => {
  return status === 'paused'
    ? "storage_state = 'draining', pause_requested_at = current_timestamp"
    : status === 'running'
      ? "storage_state = 'active', pause_requested_at = NULL"
      : null
}

const getFailedRequestDetailRecords = (value: unknown): FailedRequestDetailRecord[] => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? parsed.flatMap((entry) => {
        return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry as FailedRequestDetailRecord] : []
      })
    : []
}

const isAnthropicRefusalDetail = (detail: FailedRequestDetailRecord): boolean => {
  const error = typeof detail.error === 'string' ? detail.error : ''
  const failureCode = typeof detail.failureCode === 'string' ? detail.failureCode : ''
  const providerDiagnostics =
    detail.providerDiagnostics
    && typeof detail.providerDiagnostics === 'object'
    && !Array.isArray(detail.providerDiagnostics)
      ? (detail.providerDiagnostics as Record<string, unknown>)
      : null
  const initialStopReason =
    providerDiagnostics?.initial
    && typeof providerDiagnostics.initial === 'object'
    && !Array.isArray(providerDiagnostics.initial)
      ? (providerDiagnostics.initial as Record<string, unknown>).stopReason
      : null
  const fallbackStopReason =
    providerDiagnostics?.fallback
    && typeof providerDiagnostics.fallback === 'object'
    && !Array.isArray(providerDiagnostics.fallback)
      ? (providerDiagnostics.fallback as Record<string, unknown>).stopReason
      : null

  return (
    failureCode === 'anthropic_refusal_empty_response'
    || error.includes('failure_code=anthropic_refusal_empty_response')
    || ((failureCode === 'anthropic_empty_response' || error.includes('failure_code=anthropic_empty_response'))
      && (error.includes('stop_reason=refusal') || initialStopReason === 'refusal' || fallbackStopReason === 'refusal'))
  )
}

const getFailedRequestSummary = (rows: Array<{failedRequestsDetails: unknown}>): FailedRequestSummary => {
  const detailRecords = rows.flatMap((row) => {
    return getFailedRequestDetailRecords(row.failedRequestsDetails)
  })
  const anthropicRefusalArticleIds = detailRecords.reduce((set, detail) => {
    if (!isAnthropicRefusalDetail(detail)) {
      return set
    }

    const articleId = typeof detail.articleId === 'string' ? detail.articleId : null

    return articleId ? new Set([...set, articleId]) : set
  }, new Set<string>())

  return {
    anthropicRefusalArticles: anthropicRefusalArticleIds.size,
    anthropicRefusals: detailRecords.filter((detail) => {
      return isAnthropicRefusalDetail(detail)
    }).length,
    persistedFailedRequests: detailRecords.length,
  }
}

const resetJudgmentJobLocalSqliteState = async ({jobId, storageState}: {jobId: string; storageState: string}) => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return
  }

  const shouldUseCrashContainedDeleteFlush =
    getJudgmentJobRepairMode({hasLocalSqliteState: true, job: {status: 'failed', storageState}})
    === 'offline_repair_required'

  if (shouldUseCrashContainedDeleteFlush) {
    const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy: judgmentJobServerId, jobId})

    if (flushResult.errorMessage !== null) {
      if (!isJudgmentJobSqliteIsolatedImportLeaseConflict(flushResult.errorMessage)) {
        await runJudgmentJobRepairAction({action: 'quarantine', jobId, reason: flushResult.errorMessage})
      }

      throw new HttpError(
        409,
        `Start Job Clean stopped safely for ${jobId}: ${flushResult.errorMessage} Local SQLite data was left in place.`,
      )
    }
  } else {
    await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId})
  }

  await sqliteService.deleteJob(jobId)
}

export const judgmentsJobsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/judgmentsjobs',
    async ({body}) => {
      console.log('Fetching judgmentsjobs')

      // Check if a job already exists for this project
      const existingJob = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(body.projectId)}'
        LIMIT 1
      `)

      if (existingJob.length > 0) {
        return {error: 'A job already exists for this project', data: null}
      }

      assertJudgingRuntimeCanRun()
      await assertProjectRuntimeModelMatch(body.projectId)

      const [job] = await getAppDatabaseService().queryJson<{
        id: string
        status: string
        storageState: string
        quarantinedAt: unknown
        quarantineReason: string | null
        lastImportStartedAt: unknown
        lastImportCompletedAt: unknown
        lastImportErrorAt: unknown
        lastImportError: string | null
        lastImportExitCode: number | null
        importFailureCount: number | null
        pauseRequestedAt: unknown
        createdAt: unknown
        projectId: string
      }>(`
        INSERT INTO app.judgment_job (id, project_id, status)
        VALUES (${getQuotedStringList([crypto.randomUUID(), body.projectId, 'running']).join(', ')})
        RETURNING
          id,
          status,
          storage_state AS storageState,
          quarantined_at AS quarantinedAt,
          quarantine_reason AS quarantineReason,
          last_import_started_at AS lastImportStartedAt,
          last_import_completed_at AS lastImportCompletedAt,
          last_import_error_at AS lastImportErrorAt,
          last_import_error AS lastImportError,
          last_import_exit_code AS lastImportExitCode,
          import_failure_count AS importFailureCount,
          pause_requested_at AS pauseRequestedAt,
          created_at AS createdAt,
          project_id AS projectId
      `)

      if (!job) {
        throw new Error('Failed to create judgments job')
      }

      try {
        await getJudgmentJobSqliteService().initializeJob(job.id)
        await getJudgmentJobSqliteService().runIsolatedPreflight(job.id)
      } catch (error) {
        await getJudgmentJobSqliteService()
          .deleteJob(job.id)
          .catch(() => {
            return undefined
          })
        await getAppDatabaseService().transaction(async (tx) => {
          await deleteJudgmentJobSafelyTx({jobId: job.id, tx})
        })
        throw error
      }

      return {
        data: {
          jobId: job.id,
          status: job.status,
          storageState: job.storageState,
          quarantinedAt: getDateValue(job.quarantinedAt),
          quarantineReason: job.quarantineReason,
          lastImportStartedAt: getDateValue(job.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(job.lastImportErrorAt),
          lastImportError: job.lastImportError,
          lastImportExitCode: job.lastImportExitCode,
          importFailureCount: Number(job.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(job.pauseRequestedAt),
          createdAt: job.createdAt,
          projectId: job.projectId,
        },
        error: null,
      }
    },
    {body: t.Object({projectId: t.String(), agentConfig: t.Optional(t.Any())})},
  )
  .get(
    '/api/judgmentsjobs/:id/health',
    async ({params}) => {
      return runJudgmentJobsRead(async () => {
        const db = getJudgmentJobsReadDatabase()
        const currentNow = new Date()
        const {job, projectModelId} = await getJobContext({db, jobId: params.id})
        const workIdentity = getJudgmentJobWorkIdentity({job, modelId: projectModelId})
        const [sqliteHealth, importConsumer, importWorkLeasesByJobId, endpointHealth] = await Promise.all([
          getSqliteHealthForReadableRoute({db, jobId: job.id}),
          getJudgmentImportConsumerAvailability(),
          getJudgmentImportWorkLeasesByJobId({db, jobIds: [job.id], now: currentNow}),
          getJudgmentJobEndpointHealth({db, modelId: projectModelId}),
        ])
        const storagePolicy = getStoragePolicy({job, sqliteHealth})
        const recommendedNextAction = getRecommendedHealthAction({job, sqliteHealth})
        const progress = getJudgmentJobHealthProgress({
          endpointHealth,
          importConsumer,
          importWorkLeases: importWorkLeasesByJobId.get(job.id) ?? [],
          job,
          now: currentNow,
          recommendedNextAction,
          sqliteHealth,
          workIdentity,
        })

        return {
          ...progress,
          jobId: job.id,
          storageState: job.storageState,
          storagePolicy,
          recommendedNextAction,
          endpointAvailability: endpointHealth.diagnostics,
          importMetadata: {
            importFailureCount: job.importFailureCount,
            lastImportCompletedAt: job.lastImportCompletedAt,
            lastImportError: job.lastImportError,
            lastImportErrorAt: job.lastImportErrorAt,
            lastImportExitCode: job.lastImportExitCode,
            lastImportStartedAt: job.lastImportStartedAt,
            pauseRequestedAt: job.pauseRequestedAt,
          },
          quarantine: {quarantinedAt: job.quarantinedAt, quarantineReason: job.quarantineReason},
          liveSqlite: sqliteHealth,
        }
      })
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      return runJudgmentJobsRead(async () => {
        const db = getJudgmentJobsReadDatabase()
        const {job, projectModelId} = await getJobContext({db, jobId: params.id})
        const sqliteService = getJudgmentJobSqliteService()
        const sqliteHealthPromise = getSqliteHealthForReadableRoute({db, jobId: job.id})
        const leaseMetadataPromise = shouldCurrentServerRunJudgingLoops()
          ? sqliteService.getJudgmentJobLeaseMetadata(job.id)
          : Promise.resolve(null)
        const storageProjectionPromise = getJudgmentJobStorageProjection(job.projectId, db)

        const [sqliteHealth, leaseMetadata, storageProjection, totalTokenUsage, tokenUsageRows, failedRequestRows] =
          await Promise.all([
            sqliteHealthPromise,
            leaseMetadataPromise,
            storageProjectionPromise,
            db.queryJson<{
              totalTokens: number | null
              totalPromptTokens: number | null
              totalCompletionTokens: number | null
              totalRequests: number | null
            }>(`
          SELECT
            SUM(total_tokens) AS totalTokens,
            SUM(total_prompt_tokens) AS totalPromptTokens,
            SUM(total_completion_tokens) AS totalCompletionTokens,
            SUM(requests) AS totalRequests
          FROM app.token_use
          WHERE judgment_job_id = '${escapeSqlString(job.id)}'
        `),
            db.queryJson<{
              createdAt: unknown
              dailyTokens: number | null
              dailyPromptTokens: number | null
              dailyCompletionTokens: number | null
              requests: number | null
            }>(`
          SELECT
            created_at AS createdAt,
            total_tokens AS dailyTokens,
            total_prompt_tokens AS dailyPromptTokens,
            total_completion_tokens AS dailyCompletionTokens,
            requests
          FROM app.token_use
          WHERE judgment_job_id = '${escapeSqlString(job.id)}'
          ORDER BY created_at ASC
        `),
            db.queryJson<{failedRequestsDetails: unknown}>(`
          SELECT TO_JSON(failed_requests_details) AS failedRequestsDetails
          FROM app.token_use
          WHERE judgment_job_id = '${escapeSqlString(job.id)}'
            AND has_failed_requests = TRUE
        `),
          ])
        const normalizedTokenUsageRows = tokenUsageRows.reduce<
          Array<{
            createdAt: Date
            dailyTokens: number | string | null
            dailyPromptTokens: number | string | null
            dailyCompletionTokens: number | string | null
            requests: number | string | null
          }>
        >((acc, row) => {
          const createdAt = getDateValue(row.createdAt)
          return createdAt ? [...acc, {...row, createdAt}] : acc
        }, [])
        const tokenUsagePerDay = aggregateTokenUsagePerDay(normalizedTokenUsageRows)
        const requestRuntimeStats = getJudgmentRequestStats(job.id)
        const failedRequestSummary = getFailedRequestSummary(failedRequestRows)
        const storagePolicy = getStoragePolicy({job, sqliteHealth})
        const recentTransfer = getJudgmentJobStorageTransferRuntime(job.id)
        const providerConnection = await getProviderConnectionForStoredModel(projectModelId, db)
        const effectiveBaseURL = providerConnection
          ? getProviderConnectionEffectiveBaseURL({
              baseURL: providerConnection.baseURL,
              config: providerConnection.config,
              providerKind: providerConnection.providerKind,
              savedModelIds: [projectModelId],
            })
          : null
        const endpointAvailability = effectiveBaseURL
          ? getJudgmentEndpointAvailabilityDiagnostics(
              getJudgmentEndpointAvailability({effectiveBaseURL, providerConnectionId: providerConnection?.id ?? null}),
            )
          : null
        const effectiveProviderCap = getEffectiveProviderCap({
          job: {
            id: job.id,
            maxInflightRequests: providerConnection?.maxInflightRequests ?? null,
            modelId: projectModelId,
            modelName: providerConnection?.label ?? null,
            modelProvider: providerConnection?.providerKind ?? null,
            projectId: job.projectId,
            providerConnectionId: providerConnection?.id ?? null,
            quarantineReason: job.quarantineReason,
            storageState: job.storageState,
          },
        })
        const dispatchStats = await getJudgmentDispatchProviderStats({
          jobId: job.id,
          providerConnectionId: providerConnection?.id ?? null,
          providerMaxInflightRequests: effectiveProviderCap.maxInflight,
          providerUsesFamilyDefault: effectiveProviderCap.usesFamilyDefault,
        })
        const providerActiveFillPct =
          dispatchStats.providerActiveLimit > 0
            ? Math.round((dispatchStats.providerActivePromptCount / dispatchStats.providerActiveLimit) * 100)
            : null
        const providerPrefetchFillPct =
          dispatchStats.providerQueueLimit > 0
            ? Math.round((dispatchStats.providerQueuedPromptCount / dispatchStats.providerQueueLimit) * 100)
            : null

        const promptStats = {
          claimed: sqliteHealth.promptCounts.claimed,
          judged: sqliteHealth.promptCounts.judged,
          ready: sqliteHealth.promptCounts.ready,
          running: sqliteHealth.promptCounts.running,
          skipped: sqliteHealth.promptCounts.skipped,
        }
        const storageHealth = {
          ...sqliteHealth,
          ...(storageProjection ? {projection: storageProjection} : {}),
          ...(recentTransfer ? {recentTransfer} : {}),
        }

        return {
          ...job,
          leaseMetadata,
          promptStats,
          storagePolicy,
          storageHealth,
          judgingRuntime: getJudgingRuntime(),
          totalTokenUsage: {
            totalTokens: Number(totalTokenUsage[0]?.totalTokens || 0),
            totalPromptTokens: Number(totalTokenUsage[0]?.totalPromptTokens || 0),
            totalCompletionTokens: Number(totalTokenUsage[0]?.totalCompletionTokens || 0),
          },
          requestStats: {
            dispatch: {
              jobActivePrompts: dispatchStats.jobActivePromptCount,
              jobQueuedPrompts: dispatchStats.jobQueuedPromptCount,
              providerActiveFillPct,
              providerActiveLimit: dispatchStats.providerActiveLimit,
              providerActivePrompts: dispatchStats.providerActivePromptCount,
              providerPrefetchFillPct,
              providerQueueLimit: dispatchStats.providerQueueLimit,
              providerQueuedPrompts: dispatchStats.providerQueuedPromptCount,
            },
            endpointAvailability,
            failures: failedRequestSummary,
            inFlight: requestRuntimeStats.inFlight,
            attempts: Number(totalTokenUsage[0]?.totalRequests || 0) + requestRuntimeStats.pendingPersistedAttempts,
          },
          tokenUsagePerDay: tokenUsagePerDay.map((row) => {
            const dailyTokens = Number(row.dailyTokens ?? 0)
            const dailyPromptTokens = Number(row.dailyPromptTokens ?? 0)
            const dailyCompletionTokens = Number(row.dailyCompletionTokens ?? 0)
            const requests = Number(row.requests ?? 0)
            return {...row, dailyTokens, dailyPromptTokens, dailyCompletionTokens, requests}
          }),
        }
      })
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs-unassessed-count',
    async ({query}) => {
      const {projectDateFrom, projectDateTo, importRouteIds, projectModelId, job} = await getJobContext({
        jobId: query.jobId,
      })
      const freshness = await getProjectMartFreshnessState(job.projectId)

      const cacheKey = getUnassessedCountCacheKey(
        job.projectId,
        projectModelId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
        job.useTitle,
        job.useAbstract,
        job.useFulltext,
        job.useFulltextNoImages,
        freshness.dirtyToken,
        freshness.lastCompletedRefreshToken,
      )
      const cached = unassessedCountCache.get(cacheKey)
      const now = Date.now()
      if (freshness.isFresh && cached && cached.expiresAt > now) {
        return {count: cached.value}
      }

      const count = await getUnassessedCountFromOlap({
        projectId: job.projectId,
        projectModelId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
        useTitle: job.useTitle,
        useAbstract: job.useAbstract,
        useFulltext: job.useFulltext,
        useFulltextNoImages: job.useFulltextNoImages,
        preferRawFallback: !freshness.isFresh,
      })

      if (freshness.isFresh) {
        unassessedCountCache.set(cacheKey, {value: count, expiresAt: now + unassessedCountTTLms})
      }

      return {count}
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get(
    '/api/judgmentsjobs-unassessed-articles',
    async ({query}) => {
      const {projectDateFrom, projectDateTo, importRouteIds, projectModelId, job} = await getJobContext({
        jobId: query.jobId,
      })
      const freshness = await getProjectMartFreshnessState(job.projectId)

      const {articles} = await getUnassessedArticlesFromOlap({
        projectId: job.projectId,
        projectModelId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
        useTitle: job.useTitle,
        useAbstract: job.useAbstract,
        useFulltext: job.useFulltext,
        useFulltextNoImages: job.useFulltextNoImages,
        limit: 100,
        offset: 0,
        preferRawFallback: !freshness.isFresh,
      })

      const unassessedArticles = articles.map((a) => {
        return {
          id: a.id,
          articleId: a.articleId,
          articleTitle: a.articleTitle,
          articleAuthors: null,
          articleCreatedAt: a.articleCreatedAt,
          articleUpdatedAt: a.articleUpdatedAt,
        }
      })

      return {data: unassessedArticles, error: null}
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get('/api/judgmentsjobs', async () => {
    return runJudgmentJobsRead(async () => {
      const db = getJudgmentJobsReadDatabase()
      const jobs = await db.queryJson<{
        id: string
        createdAt: unknown
        updatedAt: unknown
        projectId: string
        status: string
        error: unknown
        storageState: string
        quarantinedAt: unknown
        quarantineReason: string | null
        lastImportStartedAt: unknown
        lastImportCompletedAt: unknown
        lastImportErrorAt: unknown
        lastImportError: string | null
        lastImportExitCode: number | null
        importFailureCount: number | null
        pauseRequestedAt: unknown
        projectName: string | null
      }>(`
        SELECT
          jj.id AS id,
          jj.created_at AS createdAt,
          jj.updated_at AS updatedAt,
          jj.project_id AS projectId,
          jj.status AS status,
          TO_JSON(jj.error) AS error,
          jj.storage_state AS storageState,
          jj.quarantined_at AS quarantinedAt,
          jj.quarantine_reason AS quarantineReason,
          jj.last_import_started_at AS lastImportStartedAt,
          jj.last_import_completed_at AS lastImportCompletedAt,
          jj.last_import_error_at AS lastImportErrorAt,
          jj.last_import_error AS lastImportError,
          jj.last_import_exit_code AS lastImportExitCode,
          jj.import_failure_count AS importFailureCount,
          jj.pause_requested_at AS pauseRequestedAt,
          p.name AS projectName
        FROM app.judgment_job jj
        INNER JOIN app.project p ON jj.project_id = p.id
        WHERE p.archived = FALSE
        ORDER BY jj.created_at ASC
      `)
      const sqliteHealthByJobId = await getSqliteHealthMapForReadableRoute({
        db,
        jobIds: jobs.map((job) => {
          return job.id
        }),
      })
      const jobsWithHealth = jobs.map((job) => {
        const normalizedJob = {
          ...job,
          createdAt: getDateValue(job.createdAt),
          updatedAt: getDateValue(job.updatedAt),
          error: getJsonValue(job.error) as string[] | null,
          quarantinedAt: getDateValue(job.quarantinedAt),
          lastImportStartedAt: getDateValue(job.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(job.lastImportErrorAt),
          importFailureCount: Number(job.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(job.pauseRequestedAt),
        }
        const sqliteHealth = sqliteHealthByJobId.get(job.id)

        if (!sqliteHealth) {
          throw getMaintenanceUnavailableError(
            `fresh SQLite health projection is unavailable for judgment job ${job.id}`,
          )
        }

        const badges = getJobHealthBadges({job: normalizedJob, sqliteHealth})

        return {...normalizedJob, health: {badges, isHealthy: badges.length === 1 && badges[0] === 'Healthy'}}
      })

      return {data: jobsWithHealth, error: null}
    })
  })
  .get('/api/judgmentsjobs-health', async () => {
    return runJudgmentJobsRead(async () => {
      const db = getJudgmentJobsReadDatabase()
      const currentNow = new Date()
      const jobs = await db.queryJson<{
        id: string
        status: string
        projectId: string
        projectModelId: string
        useTitle: boolean | null
        useAbstract: boolean | null
        useFulltext: boolean | null
        useFulltextNoImages: boolean | null
        storageState: string
        quarantinedAt: unknown
        quarantineReason: string | null
        lastImportStartedAt: unknown
        lastImportCompletedAt: unknown
        lastImportErrorAt: unknown
        lastImportError: string | null
        lastImportExitCode: number | null
        importFailureCount: number | null
        pauseRequestedAt: unknown
      }>(`
        SELECT
          jj.id AS id,
          jj.status AS status,
          jj.project_id AS projectId,
          COALESCE(p.model_id, '') AS projectModelId,
          p.use_title AS useTitle,
          p.use_abstract AS useAbstract,
          p.use_fulltext AS useFulltext,
          p.use_fulltext_no_images AS useFulltextNoImages,
          jj.storage_state AS storageState,
          jj.quarantined_at AS quarantinedAt,
          jj.quarantine_reason AS quarantineReason,
          jj.last_import_started_at AS lastImportStartedAt,
          jj.last_import_completed_at AS lastImportCompletedAt,
          jj.last_import_error_at AS lastImportErrorAt,
          jj.last_import_error AS lastImportError,
          jj.last_import_exit_code AS lastImportExitCode,
          jj.import_failure_count AS importFailureCount,
          jj.pause_requested_at AS pauseRequestedAt
        FROM app.judgment_job jj
        INNER JOIN app.project p ON jj.project_id = p.id
        ORDER BY jj.created_at ASC
      `)
      const jobIds = jobs.map((job) => {
        return job.id
      })
      const sqliteHealthByJobId = await getSqliteHealthMapForReadableRoute({db, jobIds})
      const [importConsumer, importWorkLeasesByJobId] = await Promise.all([
        getJudgmentImportConsumerAvailability(),
        getJudgmentImportWorkLeasesByJobId({db, jobIds, now: currentNow}),
      ])
      const jobsWithHealth = await Promise.all(
        jobs.map(async (job) => {
          const normalizedJob = {
            ...job,
            importFailureCount: Number(job.importFailureCount ?? 0),
            lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
            lastImportErrorAt: getDateValue(job.lastImportErrorAt),
            lastImportStartedAt: getDateValue(job.lastImportStartedAt),
            pauseRequestedAt: getDateValue(job.pauseRequestedAt),
            quarantinedAt: getDateValue(job.quarantinedAt),
            useAbstract: job.useAbstract ?? true,
            useFulltext: job.useFulltext ?? false,
            useFulltextNoImages: job.useFulltextNoImages ?? false,
            useTitle: job.useTitle ?? true,
          }
          const sqliteHealth = sqliteHealthByJobId.get(job.id)
          const workIdentity = getJudgmentJobWorkIdentity({job: normalizedJob, modelId: job.projectModelId})
          const endpointHealth = await getJudgmentJobEndpointHealth({db, modelId: job.projectModelId})

          if (!sqliteHealth) {
            throw getMaintenanceUnavailableError(
              `fresh SQLite health projection is unavailable for judgment job ${job.id}`,
            )
          }

          const action = getRecommendedHealthAction({job: normalizedJob, sqliteHealth})
          const progress = getJudgmentJobHealthProgress({
            endpointHealth,
            importConsumer,
            importWorkLeases: importWorkLeasesByJobId.get(job.id) ?? [],
            job: normalizedJob,
            now: currentNow,
            recommendedNextAction: action,
            sqliteHealth,
            workIdentity,
          })

          return {
            ...progress,
            action,
            endpointAvailability: endpointHealth.diagnostics,
            job: normalizedJob,
            sqliteHealth,
          }
        }),
      )
      const progressStates = getProgressStateCounts(jobsWithHealth)
      const jobsSummary = jobsWithHealth.map(({action, endpointAvailability, job, sqliteHealth, ...progress}) => {
        const normalizedJob = {id: job.id, projectId: job.projectId, status: job.status, storageState: job.storageState}

        return {...progress, action, endpointAvailability, job: normalizedJob, jobId: job.id, sqliteHealth}
      })

      return {
        data: {
          activeImport: progressStates.activeImport,
          blockedImport: progressStates.blockedImport,
          completionAckBacklog: progressStates.waitingForOwnerAck,
          cooldown: progressStates.cooldown,
          healthy: jobsWithHealth.filter(({action, job}) => {
            return isHealthyJob({action, job})
          }).length,
          draining: jobsWithHealth.filter(({job}) => {
            return job.storageState === 'draining'
          }).length,
          offlineRepairRequired: jobsWithHealth.filter(({action}) => {
            return action === 'repair_offline_required'
          }).length,
          quarantined: jobsWithHealth.filter(({job}) => {
            return job.storageState === 'quarantined'
          }).length,
          retainedOutbox: jobsWithHealth.filter(({sqliteHealth}) => {
            return hasRetainedOutbox(sqliteHealth)
          }).length,
          staleImport: jobsWithHealth.filter(({job}) => {
            return isStaleImportJob(job)
          }).length,
          importConsumer,
          jobs: jobsSummary,
          progressStates,
          repairRequired: progressStates.repairRequired,
        },
        error: null,
      }
    })
  })
  .get('/api/judgmentsjobs-total-token-usage', async () => {
    const [totalUsage] = await getAppDatabaseService().queryJson<{
      totalTokens: number | null
      totalPromptTokens: number | null
      totalCompletionTokens: number | null
    }>(`
      SELECT
        SUM(total_tokens) AS totalTokens,
        SUM(total_prompt_tokens) AS totalPromptTokens,
        SUM(total_completion_tokens) AS totalCompletionTokens
      FROM app.token_use
    `)

    return {
      data: {
        totalTokens: Number(totalUsage?.totalTokens || 0),
        totalPromptTokens: Number(totalUsage?.totalPromptTokens || 0),
        totalCompletionTokens: Number(totalUsage?.totalCompletionTokens || 0),
      },
      error: null,
    }
  })
  .patch(
    '/api/judgmentsjobs/:id',
    async ({params, body}) => {
      const sqliteService = getJudgmentJobSqliteService()

      if (body.status === 'running') {
        assertJudgingRuntimeCanRun()
        const {job, projectModelId} = await getJobContext({jobId: params.id})
        await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})

        if (!sqliteService.hasJob(params.id)) {
          await sqliteService.initializeJob(params.id)
        }

        await assertJudgmentJobCanRunSqlitePreflight({
          jobId: params.id,
          quarantineReason: job.quarantineReason,
          storageState: job.storageState,
        })
      }

      const updatedJob = (await getAppDatabaseService().transaction(async (tx) => {
        const storageAssignments = getJudgmentJobMutationStorageAssignments(body.status)
        await tx.run(`
          UPDATE app.judgment_job
          SET status = ${getSqlLiteral(body.status)},
              error = ${getSqlLiteral(body.error ?? null)},
              ${storageAssignments ? `${storageAssignments},` : ''}
              updated_at = current_timestamp
          WHERE id = '${escapeSqlString(params.id)}'
        `)

        return getJudgmentJobMutationState(tx, params.id)
      })) as JudgmentJobMutationState | null

      if (body.status === 'paused') {
        await sqliteService.clearActiveQueue(params.id)
      }

      if (body.status && body.status !== 'running') {
        await sqliteService.releaseOwnedLease(params.id)
      }

      if (!updatedJob) {
        throw new Error('Job not found')
      }

      return {
        data: {
          jobId: updatedJob.id,
          status: updatedJob.status,
          storageState: updatedJob.storageState,
          quarantinedAt: getDateValue(updatedJob.quarantinedAt),
          quarantineReason: updatedJob.quarantineReason,
          lastImportStartedAt: getDateValue(updatedJob.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(updatedJob.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(updatedJob.lastImportErrorAt),
          lastImportError: updatedJob.lastImportError,
          lastImportExitCode: updatedJob.lastImportExitCode,
          importFailureCount: Number(updatedJob.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(updatedJob.pauseRequestedAt),
          updatedAt: getDateValue(updatedJob.updatedAt),
          error: getJsonValue(updatedJob.error) as string[] | null,
        },
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal('not_started'),
            t.Literal('waiting_on_llm_connection'),
            t.Literal('waiting_on_db_connection'),
            t.Literal('running'),
            t.Literal('paused'),
            t.Literal('failed'),
            t.Literal('completed'),
            t.Literal('project_removed'),
          ]),
        ),
        error: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/start-clean',
    async ({params}) => {
      assertJudgingRuntimeCanRun()

      const sqliteService = getJudgmentJobSqliteService()
      const {job, projectModelId} = await getJobContext({jobId: params.id})

      if (job.status === 'running') {
        throw new HttpError(409, `Pause job ${params.id} before starting it clean.`)
      }

      await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
      await resetJudgmentJobLocalSqliteState({jobId: params.id, storageState: job.storageState})
      await sqliteService.initializeJob(params.id)
      await assertJudgmentJobCanRunSqlitePreflight({jobId: params.id, quarantineReason: null, storageState: 'active'})

      const updatedJob = (await getAppDatabaseService().transaction(async (tx) => {
        await tx.run(`
          UPDATE app.judgment_job
          SET status = 'running',
              error = NULL,
              storage_state = 'active',
              pause_requested_at = NULL,
              quarantined_at = NULL,
              quarantine_reason = NULL,
              updated_at = current_timestamp
          WHERE id = '${escapeSqlString(params.id)}'
        `)

        return getJudgmentJobMutationState(tx, params.id)
      })) as JudgmentJobMutationState | null

      if (!updatedJob) {
        throw new Error('Job not found')
      }

      return {
        data: {
          jobId: updatedJob.id,
          status: updatedJob.status,
          storageState: updatedJob.storageState,
          quarantinedAt: getDateValue(updatedJob.quarantinedAt),
          quarantineReason: updatedJob.quarantineReason,
          lastImportStartedAt: getDateValue(updatedJob.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(updatedJob.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(updatedJob.lastImportErrorAt),
          lastImportError: updatedJob.lastImportError,
          lastImportExitCode: updatedJob.lastImportExitCode,
          importFailureCount: Number(updatedJob.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(updatedJob.pauseRequestedAt),
          updatedAt: getDateValue(updatedJob.updatedAt),
          error: getJsonValue(updatedJob.error) as string[] | null,
        },
        error: null,
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/preflight',
    async ({params}) => {
      return {data: await runJudgmentJobRepairAction({action: 'preflight', jobId: params.id}), error: null}
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/drain',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({
          action: 'drain',
          claimedBy: body?.claimedBy,
          jobId: params.id,
          systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
        }),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/checkpoint',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({
          action: 'checkpoint',
          claimedBy: body?.claimedBy,
          jobId: params.id,
          systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
        }),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/quarantine',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({action: 'quarantine', jobId: params.id, reason: body?.reason}),
        error: null,
      }
    },
    {params: t.Object({id: t.String()}), body: t.Optional(t.Object({reason: t.Optional(t.String())}))},
  )
  .post(
    '/api/judgmentsjobs/:id/unquarantine',
    async ({params}) => {
      return {data: await runJudgmentJobRepairAction({action: 'unquarantine', jobId: params.id}), error: null}
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/repair',
    async ({params, body}) => {
      return {
        data: await runJudgmentJobRepairAction({
          action: 'repair',
          claimedBy: body?.claimedBy,
          jobId: params.id,
          systemSqliteFallbackSteps: body?.systemSqliteFallbackSteps,
        }),
        error: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .delete(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      const sqliteService = getJudgmentJobSqliteService()
      const [existingJob] = await getAppDatabaseService().queryJson<{
        id: string
        quarantineReason: string | null
        storageState: string
      }>(`
        SELECT id
             , storage_state AS storageState
             , quarantine_reason AS quarantineReason
        FROM app.judgment_job
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

      if (!existingJob) {
        throw new Error('Job not found')
      }

      const shouldUseCrashContainedDeleteFlush =
        getJudgmentJobRepairMode({
          hasLocalSqliteState: sqliteService.hasJob(params.id),
          job: {status: 'failed', storageState: existingJob.storageState},
        }) === 'offline_repair_required'

      if (shouldUseCrashContainedDeleteFlush) {
        const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy: judgmentJobServerId, jobId: params.id})

        if (flushResult.errorMessage !== null) {
          if (!isJudgmentJobSqliteIsolatedImportLeaseConflict(flushResult.errorMessage)) {
            await runJudgmentJobRepairAction({action: 'quarantine', jobId: params.id, reason: flushResult.errorMessage})
          }

          throw new HttpError(
            409,
            `Delete Job stopped safely for ${params.id}: ${flushResult.errorMessage} Local SQLite data was left in place.`,
          )
        }
      }

      if (sqliteService.hasJob(params.id) && !shouldUseCrashContainedDeleteFlush) {
        await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId: params.id})
      }

      await sqliteService.deleteJob(params.id)

      await getAppDatabaseService().transaction(async (tx) => {
        await deleteJudgmentJobSafelyTx({jobId: params.id, tx})
      })

      return {data: {jobId: existingJob.id}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )

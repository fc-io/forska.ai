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
import {deleteJudgmentJobSafelyTx} from '../services/judgmentJobDeleteService.ts'
import {HttpError} from '../utils/httpError.ts'
import {getProjectMartLargeRebuildRuntimeMetrics} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {shouldCurrentServerRunWriterWork} from '../utils/serverRuntimeRole.ts'

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

const getProjectMartFreshnessState = async (projectId: string): Promise<ProjectMartFreshnessState> => {
  const [row] = await getAppDatabaseService().queryJson<{
    dirtyToken: number | null
    lastCompletedRefreshToken: number | null
  }>(`
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

const getJudgmentJobStorageProjection = async (projectId: string): Promise<JudgmentJobStorageProjection | null> => {
  const [rebuildRow] = await getAppDatabaseService().queryJson<{
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
    getAppDatabaseService().queryJson<{activeLargeRebuildProjectCount: number}>(`
      SELECT CAST(COUNT(*) AS INTEGER) AS activeLargeRebuildProjectCount
      FROM app.project_mart_large_rebuild_state
      WHERE refresh_token > 0
    `),
    getAppDatabaseService().queryJson<{remainingCurrentPhaseArticleCount: number; scopeArticleCount: number}>(`
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
  jobId,
}: {
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
    getAppDatabaseService().queryJson<{
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
    getAppDatabaseService().queryJson<{importRouteId: string}>(`
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

const getProjectModelId = async (projectId: string): Promise<string> => {
  const [project] = await getAppDatabaseService().queryJson<{modelId: string | null}>(`
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

const hasRetainedOutbox = (
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>,
) => {
  return sqliteHealth.outboxRowCount > 0 || sqliteHealth.claimedOutboxCount > 0
}

const hasOrphanedJudgedQueue = (
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>,
) => {
  return sqliteHealth.orphanedJudgedRowCount > 0
}

const hasLargeWal = (
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>,
) => {
  return sqliteHealth.walBytes >= largeWalThresholdBytes
}

const getStoragePolicy = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string}
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>
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
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>
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
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>
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
  return !shouldCurrentServerRunWriterWork()
    ? 'This server is not the active writer, so it cannot process queued prompts.'
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
    error.includes('failure_code=anthropic_empty_response')
    && (error.includes('stop_reason=refusal') || initialStopReason === 'refusal' || fallbackStopReason === 'refusal')
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
      const {job} = await getJobContext({jobId: params.id})
      const sqliteHealth = await getJudgmentJobSqliteService().getHealthSnapshot(job.id)
      const storagePolicy = getStoragePolicy({job, sqliteHealth})
      const recommendedNextAction = getRecommendedHealthAction({job, sqliteHealth})

      return {
        jobId: job.id,
        storageState: job.storageState,
        storagePolicy,
        recommendedNextAction,
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
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      const {job, projectModelId} = await getJobContext({jobId: params.id})
      const sqliteService = getJudgmentJobSqliteService()
      const sqliteHealthPromise = sqliteService.getHealthSnapshot(job.id)
      const leaseMetadataPromise = sqliteService.getJudgmentJobLeaseMetadata(job.id)
      const storageProjectionPromise = getJudgmentJobStorageProjection(job.projectId)

      const [sqliteHealth, leaseMetadata, storageProjection, totalTokenUsage, tokenUsageRows, failedRequestRows] =
        await Promise.all([
          sqliteHealthPromise,
          leaseMetadataPromise,
          storageProjectionPromise,
          getAppDatabaseService().queryJson<{
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
          getAppDatabaseService().queryJson<{
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
          getAppDatabaseService().queryJson<{failedRequestsDetails: unknown}>(`
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
      const providerConnection = await getProviderConnectionForStoredModel(projectModelId)
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
    const jobs = await getAppDatabaseService().queryJson<{
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

    const sqliteService = getJudgmentJobSqliteService()
    const jobsWithHealth = await Promise.all(
      jobs.map(async (job) => {
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
        const sqliteHealth = await sqliteService.getHealthSnapshot(job.id)
        const badges = getJobHealthBadges({job: normalizedJob, sqliteHealth})

        return {...normalizedJob, health: {badges, isHealthy: badges.length === 1 && badges[0] === 'Healthy'}}
      }),
    )

    return {data: jobsWithHealth, error: null}
  })
  .get('/api/judgmentsjobs-health', async () => {
    const jobs = await getAppDatabaseService().queryJson<{
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
    }>(`
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
        pause_requested_at AS pauseRequestedAt
      FROM app.judgment_job
      ORDER BY created_at ASC
    `)
    const sqliteService = getJudgmentJobSqliteService()
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
        }
        const sqliteHealth = await sqliteService.getHealthSnapshot(job.id)
        const action = getRecommendedHealthAction({job: normalizedJob, sqliteHealth})

        return {action, job: normalizedJob, sqliteHealth}
      }),
    )

    return {
      data: {
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
      },
      error: null,
    }
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

import {Elysia, t} from 'elysia'

import {getUnassessedArticlesFromOlap, getUnassessedCountFromOlap} from '../../services/olap/unassessedArticlesOlap.ts'
import {getDefaultJudgmentServerJobId} from '../cron/judgmentsJobs/judgmentJobServerIdentity.ts'
import {flushJudgmentJobSqliteOutbox} from '../cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getJudgmentRequestStats} from '../cron/judgmentsJobs/judgmentsRequestRuntime.ts'
import {assertStoredProviderModelRuntimeMatch} from '../providers/providerRuntimeModelGuard.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
} from '../services/appQueryHelpers.ts'
import {HttpError} from '../utils/httpError.ts'
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
  | 'repair_missing_sqlite'
  | 'wait_for_drain'
  | 'repair_quarantine'
  | 'resume_outbox_import'
  | 'retry_stale_import'

type UnassessedCountCacheValue = {value: number; expiresAt: number}
const unassessedCountTTLms = 10_000
const staleImportThresholdMs = 15 * 60 * 1_000
const unassessedCountCache = new Map<string, UnassessedCountCacheValue>()
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
) => {
  const from = projectDateFrom ? projectDateFrom.toISOString() : ''
  const to = projectDateTo ? projectDateTo.toISOString() : ''
  const routes = importRouteIds.slice().sort().join(',')
  const content = `${useTitle}|${useAbstract}|${useFulltext}|${useFulltextNoImages}`
  return `${projectId}|${projectModelId}|${from}|${to}|${routes}|${content}`
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

const getRecommendedHealthAction = ({
  job,
  sqliteHealth,
}: {
  job: {storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  sqliteHealth: Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['getHealthSnapshot']>>
}): JudgmentJobHealthAction => {
  if (job.storageState === 'quarantined') {
    return 'repair_quarantine'
  }

  if (job.storageState === 'missing') {
    return 'repair_missing_sqlite'
  }

  if (isStaleImportJob(job)) {
    return 'retry_stale_import'
  }

  if (job.storageState === 'draining') {
    return 'wait_for_drain'
  }

  if (sqliteHealth.outboxRowCount > 0 || sqliteHealth.claimedOutboxCount > 0) {
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
      } catch (error) {
        await getAppDatabaseService().run(`
          DELETE FROM app.judgment_job
          WHERE id = '${escapeSqlString(job.id)}'
        `)
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
      const recommendedNextAction = getRecommendedHealthAction({job, sqliteHealth})

      return {
        jobId: job.id,
        storageState: job.storageState,
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
      const {job} = await getJobContext({jobId: params.id})
      const sqliteService = getJudgmentJobSqliteService()
      const sqliteHealthPromise = sqliteService.getHealthSnapshot(job.id)

      const [sqliteHealth, totalTokenUsage, tokenUsageRows] = await Promise.all([
        sqliteHealthPromise,
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

      return {
        ...job,
        promptStats: sqliteHealth.promptCounts,
        storageHealth: sqliteHealth,
        judgingRuntime: getJudgingRuntime(),
        totalTokenUsage: {
          totalTokens: Number(totalTokenUsage[0]?.totalTokens || 0),
          totalPromptTokens: Number(totalTokenUsage[0]?.totalPromptTokens || 0),
          totalCompletionTokens: Number(totalTokenUsage[0]?.totalCompletionTokens || 0),
        },
        requestStats: {
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
      )
      const cached = unassessedCountCache.get(cacheKey)
      const now = Date.now()
      if (cached && cached.expiresAt > now) {
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
      })

      unassessedCountCache.set(cacheKey, {value: count, expiresAt: now + unassessedCountTTLms})

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

    return {
      data: jobs.map((job) => {
        return {
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
      }),
      error: null,
    }
  })
  .get('/api/judgmentsjobs-health', async () => {
    const jobs = await getAppDatabaseService().queryJson<{
      id: string
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
        quarantined: jobsWithHealth.filter(({job}) => {
          return job.storageState === 'quarantined'
        }).length,
        retainedOutbox: jobsWithHealth.filter(({sqliteHealth}) => {
          return sqliteHealth.outboxRowCount > 0 || sqliteHealth.claimedOutboxCount > 0
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
        const {projectModelId} = await getJobContext({jobId: params.id})

        await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})

        if (!sqliteService.hasJob(params.id)) {
          await sqliteService.initializeJob(params.id)
        }
      }

      const updatedJob = (await getAppDatabaseService().transaction(async (tx) => {
        await tx.run(`
          UPDATE app.judgment_job
          SET status = ${getSqlLiteral(body.status)},
              error = ${getSqlLiteral(body.error ?? null)},
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
  .delete(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      const sqliteService = getJudgmentJobSqliteService()
      const [existingJob] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

      if (!existingJob) {
        throw new Error('Job not found')
      }

      await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId: params.id})
      await sqliteService.deleteJob(params.id)

      await getAppDatabaseService().run(`
        DELETE FROM app.token_use
        WHERE judgment_job_id = '${escapeSqlString(params.id)}'
      `)

      await getAppDatabaseService().run(`
        DELETE FROM app.judgment_job
        WHERE id = '${escapeSqlString(params.id)}'
      `)

      return {data: {jobId: existingJob.id}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )

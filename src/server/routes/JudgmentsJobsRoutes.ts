import {eq, sql, sum} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgmentsJobs, judgmentsJobsPrompts, projectRouteLink, projects, tokenUse} from '../../db/schema'
import {getUnassessedArticlesFromOlap, getUnassessedCountFromOlap} from '../../services/olap/unassessedArticlesOlap.ts'
import {getJudgmentRequestStats} from '../cron/judgmentsJobs/judgmentsRequestRuntime.ts'
import {getDatabase} from '../utils/getDatabase'
import {withErrorHandler} from '../utils/routeErrorHandler'

type Database = ReturnType<typeof getDatabase>
type TokenUsageDaySummary = {
  date: string
  dailyTokens: number
  dailyPromptTokens: number
  dailyCompletionTokens: number
  requests: number
}

type UnassessedCountCacheValue = {value: number; expiresAt: number}
const unassessedCountTTLms = 10_000
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
  db,
  jobId,
}: {
  db: Database
  jobId: string
}): Promise<{
  job: {
    id: string
    createdAt: Date
    updatedAt: Date
    projectId: string
    status: string
    error: string[] | null
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
  const [jobWithProject] = await db
    .select({
      id: judgmentsJobs.id,
      createdAt: judgmentsJobs.createdAt,
      updatedAt: judgmentsJobs.updatedAt,
      projectId: judgmentsJobs.projectId,
      status: judgmentsJobs.status,
      error: judgmentsJobs.error,
      projectName: projects.name,
      projectModelId: projects.modelId,
      projectDateFrom: projects.dateFrom,
      projectDateTo: projects.dateTo,
      projectUseTitle: projects.useTitle,
      projectUseAbstract: projects.useAbstract,
      projectUseFulltext: projects.useFulltext,
      projectUseFulltextNoImages: projects.useFulltextNoImages,
    })
    .from(judgmentsJobs)
    .leftJoin(projects, eq(judgmentsJobs.projectId, projects.id))
    .where(eq(judgmentsJobs.id, jobId))
    .limit(1)

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
    useTitle: projectUseTitle ?? true,
    useAbstract: projectUseAbstract ?? true,
    useFulltext: projectUseFulltext ?? false,
    useFulltextNoImages: projectUseFulltextNoImages ?? false,
  }

  if (!projectModelId) {
    throw new Error('Project model ID not found')
  }

  const projectImportRoutes = await db
    .select({importRouteId: projectRouteLink.importRouteId})
    .from(projectRouteLink)
    .where(eq(projectRouteLink.projectId, job.projectId))

  return {
    job,
    projectModelId,
    projectDateFrom,
    projectDateTo,
    importRouteIds: projectImportRoutes.map((r) => {
      return r.importRouteId
    }),
  }
}

export const judgmentsJobsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/judgmentsjobs',
    async ({body}) => {
      console.log('Fetching judgmentsjobs')

      const db = getDatabase()

      // Check if a job already exists for this project
      const existingJob = await db
        .select()
        .from(judgmentsJobs)
        .where(eq(judgmentsJobs.projectId, body.projectId))
        .limit(1)

      if (existingJob.length > 0) {
        return {error: 'A job already exists for this project', data: null}
      }

      const [job] = await db.insert(judgmentsJobs).values({projectId: body.projectId, status: 'running'}).returning()

      if (!job) {
        throw new Error('Failed to create judgments job')
      }

      return {
        data: {jobId: job.id, status: job.status, createdAt: job.createdAt, projectId: job.projectId},
        error: null,
      }
    },
    {body: t.Object({projectId: t.String(), agentConfig: t.Optional(t.Any())})},
  )
  .get(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      const db = getDatabase()

      const {job} = await getJobContext({db, jobId: params.id})

      const [promptStats, totalTokenUsage, tokenUsageRows] = await Promise.all([
        db
          .select({status: judgmentsJobsPrompts.status, count: sql<number>`count(*)`})
          .from(judgmentsJobsPrompts)
          .where(eq(judgmentsJobsPrompts.jobId, job.id))
          .groupBy(judgmentsJobsPrompts.status),
        db
          .select({
            totalTokens: sum(tokenUse.totalTokens),
            totalPromptTokens: sum(tokenUse.totalPromptTokens),
            totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
            totalRequests: sum(tokenUse.requests),
          })
          .from(tokenUse)
          .where(eq(tokenUse.judgmentsJobId, job.id)),
        db
          .select({
            createdAt: tokenUse.createdAt,
            dailyTokens: sum(tokenUse.totalTokens),
            dailyPromptTokens: sum(tokenUse.totalPromptTokens),
            dailyCompletionTokens: sum(tokenUse.totalCompletionTokens),
            requests: sum(tokenUse.requests),
          })
          .from(tokenUse)
          .where(eq(tokenUse.judgmentsJobId, job.id))
          .orderBy(tokenUse.createdAt),
      ])
      const tokenUsagePerDay = aggregateTokenUsagePerDay(tokenUsageRows)

      const stats = {ready: 0, sent: 0, judged: 0, skipped: 0}
      const requestRuntimeStats = getJudgmentRequestStats(job.id)

      promptStats.forEach((stat) => {
        if (stat.status === 'ready') stats.ready = stat.count
        if (stat.status === 'sent') stats.sent = stat.count
        if (stat.status === 'judged') stats.judged = stat.count
        if (stat.status === 'skipped') stats.skipped = stat.count
      })

      return {
        ...job,
        promptStats: stats,
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
      const db = getDatabase()

      const {projectDateFrom, projectDateTo, importRouteIds, projectModelId, job} = await getJobContext({
        db,
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
      const db = getDatabase()

      const {projectDateFrom, projectDateTo, importRouteIds, projectModelId, job} = await getJobContext({
        db,
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
    const db = getDatabase()

    // Filter out jobs from archived projects
    const jobs = await db
      .select({
        id: judgmentsJobs.id,
        createdAt: judgmentsJobs.createdAt,
        updatedAt: judgmentsJobs.updatedAt,
        projectId: judgmentsJobs.projectId,
        status: judgmentsJobs.status,
        error: judgmentsJobs.error,
        projectName: projects.name,
      })
      .from(judgmentsJobs)
      .innerJoin(projects, eq(judgmentsJobs.projectId, projects.id))
      .where(eq(projects.archived, false))
      .orderBy(judgmentsJobs.createdAt)

    return {data: jobs, error: null}
  })
  .get('/api/judgmentsjobs-total-token-usage', async () => {
    const db = getDatabase()

    const [totalUsage] = await db
      .select({
        totalTokens: sum(tokenUse.totalTokens),
        totalPromptTokens: sum(tokenUse.totalPromptTokens),
        totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
      })
      .from(tokenUse)

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
      const db = getDatabase()

      const [updatedJob] = await db
        .update(judgmentsJobs)
        .set({status: body.status, error: body.error, updatedAt: new Date()})
        .where(eq(judgmentsJobs.id, params.id))
        .returning()

      if (!updatedJob) {
        throw new Error('Job not found')
      }

      const shouldClearQueue = body.status === 'paused'

      if (shouldClearQueue) {
        await db.delete(judgmentsJobsPrompts).where(eq(judgmentsJobsPrompts.jobId, updatedJob.id))

        await db
          .update(judgmentsJobs)
          .set({cursorLastCreatedAt: null, cursorLastArticleId: null})
          .where(eq(judgmentsJobs.id, updatedJob.id))
      }

      return {
        data: {
          jobId: updatedJob.id,
          status: updatedJob.status,
          updatedAt: updatedJob.updatedAt,
          error: updatedJob.error,
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
      const db = getDatabase()

      const [deletedJob] = await db
        .delete(judgmentsJobs)
        .where(eq(judgmentsJobs.id, params.id))
        .returning({id: judgmentsJobs.id})

      if (!deletedJob) {
        throw new Error('Job not found')
      }

      return {data: {jobId: deletedJob.id}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )

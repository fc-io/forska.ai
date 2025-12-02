import type {SQL} from 'drizzle-orm'
import {eq, gte, lte, sql, sum} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  judgmentsJobs,
  judgmentsJobsArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
  tokenUse,
} from '../../db/schema'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase'
import {withErrorHandler} from '../utils/routeErrorHandler'

type Database = ReturnType<typeof getDatabase>

type UnassessedCountCacheValue = {value: number; expiresAt: number}
const unassessedCountTTLms = 10_000
const unassessedCountCache = new Map<string, UnassessedCountCacheValue>()
const getUnassessedCountCacheKey = (
  projectId: string,
  projectModelId: string,
  projectDateFrom: Date | null | undefined,
  projectDateTo: Date | null | undefined,
  importRouteIds: string[],
) => {
  const from = projectDateFrom ? projectDateFrom.toISOString() : ''
  const to = projectDateTo ? projectDateTo.toISOString() : ''
  const routes = importRouteIds.slice().sort().join(',')
  return `${projectId}|${projectModelId}|${from}|${to}|${routes}`
}

const buildProjectDateConditions = ({
  projectDateFrom,
  projectDateTo,
}: {
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
}): SQL[] => {
  const conditions: SQL[] = []

  if (projectDateFrom) {
    conditions.push(gte(articles.articleCreatedAt, projectDateFrom))
  }

  if (projectDateTo) {
    conditions.push(lte(articles.articleCreatedAt, projectDateTo))
  }

  return conditions
}

const buildProjectPromptCondition = (projectId: string, projectModelId: string): SQL => {
  return sql`EXISTS (
    SELECT 1 FROM ${projectPrompts} pp
    WHERE pp.project_id = ${projectId}::uuid
    AND NOT EXISTS (
      SELECT 1 FROM ${judgments} j
      WHERE j."article_id" = ${articles.id}
      AND j."prompt_id" = pp."prompt_id"
      AND j."model_id" = ${projectModelId}::uuid
    )
  )`
}

const buildProjectRouteCondition = (importRouteIds: string[]): SQL => {
  if (importRouteIds.length === 0) {
    return sql`FALSE`
  }

  const routeIdArray = sql.join(
    importRouteIds.map((routeId) => {
      return sql`${routeId}::uuid`
    }),
    sql`,`,
  )

  return sql`EXISTS (
    SELECT 1
    FROM ${articleRouteLink} arl
    WHERE arl."article_id" = ${articles.id}
    AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
  )`
}

const getUnassessedArticlesCount = async ({
  db,
  projectId,
  projectModelId,
  projectDateFrom,
  projectDateTo,
  importRouteIds,
}: {
  db: Database
  projectId: string
  projectModelId: string
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  importRouteIds: string[]
}): Promise<number> => {
  const cacheKey = getUnassessedCountCacheKey(projectId, projectModelId, projectDateFrom, projectDateTo, importRouteIds)
  const cached = unassessedCountCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const dateConditions = buildProjectDateConditions({projectDateFrom, projectDateTo})

  // Join-based rewrite: project prompts + left join judgments; count DISTINCT articles missing a judgment
  const allConditions: SQL[] = [sql`${judgments.id} IS NULL`, ...dateConditions]

  console.time('getUnassessedArticlesCount')

  let countQuery = db
    .select({count: sql<number>`COUNT(DISTINCT ${articles.id})`})
    .from(articles)
    .innerJoin(projectPrompts, eq(projectPrompts.projectId, projectId))
    .leftJoin(
      judgments,
      sql`${judgments.articleId} = ${articles.id} AND ${judgments.promptId} = ${projectPrompts.promptId} AND ${judgments.modelId} = ${projectModelId}::uuid`,
    )

  if (importRouteIds.length > 0) {
    // Restrict via article_route_link and allowed route ids
    countQuery = countQuery.innerJoin(articleRouteLink, eq(articleRouteLink.articleId, articles.id)).where(
      sql`${sql.join(allConditions, sql` AND `)} AND ${articleRouteLink.importRouteId} = ANY(ARRAY[${sql.join(
        importRouteIds.map((id) => {
          return sql`${id}::uuid`
        }),
        sql`,`,
      )}])`,
    )
  } else {
    countQuery = countQuery.where(sql`${sql.join(allConditions, sql` AND `)}`)
  }

  const [{count: unassessedCount = 0} = {count: 0}] = await countQuery
  console.timeEnd('getUnassessedArticlesCount')
  const value = Number(unassessedCount)
  unassessedCountCache.set(cacheKey, {value, expiresAt: now + unassessedCountTTLms})
  return value
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
    })
    .from(judgmentsJobs)
    .leftJoin(projects, eq(judgmentsJobs.projectId, projects.id))
    .where(eq(judgmentsJobs.id, jobId))
    .limit(1)

  if (!jobWithProject) {
    throw new Error('Job not found')
  }

  const {projectDateFrom, projectDateTo, projectModelId, ...job} = jobWithProject

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

const getUnassessedArticles = async ({
  db,
  projectId,
  projectModelId,
  projectDateFrom,
  projectDateTo,
  importRouteIds,
}: {
  db: Database
  projectId: string
  projectModelId: string
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  importRouteIds: string[]
}): Promise<
  {
    id: string
    articleId: string | null
    articleTitle: string
    articleAuthors: string[] | null
    articleCreatedAt: Date | null
    articleUpdatedAt: Date | null
  }[]
> => {
  const dateConditions: SQL[] = []
  if (projectDateFrom) {
    dateConditions.push(gte(articles.articleCreatedAt, projectDateFrom))
  }
  if (projectDateTo) {
    dateConditions.push(lte(articles.articleCreatedAt, projectDateTo))
  }

  const allConditions: SQL[] = [sql`${judgments.id} IS NULL`]
  if (dateConditions.length > 0) {
    allConditions.push(...dateConditions)
  }

  let query = db
    .select({
      id: articles.id,
      articleId: articles.articleId,
      articleTitle: articles.articleTitle,
      articleAuthors: articles.articleAuthors,
      articleCreatedAt: articles.articleCreatedAt,
      articleUpdatedAt: articles.articleUpdatedAt,
    })
    .from(articles)
    .innerJoin(projectPrompts, eq(projectPrompts.projectId, projectId))
    .leftJoin(
      judgments,
      sql`${judgments.articleId} = ${articles.id} AND ${judgments.promptId} = ${projectPrompts.promptId} AND ${judgments.modelId} = ${projectModelId}::uuid`,
    )
    .groupBy(
      articles.id,
      articles.articleId,
      articles.articleTitle,
      articles.articleAuthors,
      articles.articleCreatedAt,
      articles.articleUpdatedAt,
    )

  if (importRouteIds.length > 0) {
    query = query.innerJoin(articleRouteLink, eq(articleRouteLink.articleId, articles.id)).where(
      sql`${sql.join(allConditions, sql` AND `)} AND ${articleRouteLink.importRouteId} = ANY(ARRAY[${sql.join(
        importRouteIds.map((id) => {
          return sql`${id}::uuid`
        }),
        sql`,`,
      )}])`,
    )
  } else {
    query = query.where(sql`${sql.join(allConditions, sql` AND `)}`)
  }

  const articlesToAssess = await query
    .orderBy(
      sql`COALESCE(${articles.articleUpdatedAt}, ${articles.articleCreatedAt}, ${articles.createdAt}) DESC, ${articles.id} DESC`,
    )
    .limit(100)

  return articlesToAssess
}

export const judgmentsJobsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
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

      const {job, projectDateFrom, projectDateTo, importRouteIds} = await getJobContext({db, jobId: params.id})

      const [articleStats, totalTokenUsage, tokenUsagePerDay] = await Promise.all([
        db
          .select({status: judgmentsJobsArticles.status, count: sql<number>`count(*)::int`})
          .from(judgmentsJobsArticles)
          .where(eq(judgmentsJobsArticles.jobId, job.id))
          .groupBy(judgmentsJobsArticles.status),
        db
          .select({
            totalTokens: sum(tokenUse.totalTokens),
            totalPromptTokens: sum(tokenUse.totalPromptTokens),
            totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
          })
          .from(tokenUse)
          .where(eq(tokenUse.judgmentsJobId, job.id)),
        db
          .select({
            date: sql<string>`DATE(created_at AT TIME ZONE 'UTC')`,
            dailyTokens: sum(tokenUse.totalTokens),
            dailyPromptTokens: sum(tokenUse.totalPromptTokens),
            dailyCompletionTokens: sum(tokenUse.totalCompletionTokens),
            requests: sum(tokenUse.requests),
          })
          .from(tokenUse)
          .where(eq(tokenUse.judgmentsJobId, job.id))
          .groupBy(sql`DATE(created_at AT TIME ZONE 'UTC')`)
          .orderBy(sql`DATE(created_at AT TIME ZONE 'UTC')`),
      ])

      const stats = {ready: 0, sent: 0, judged: 0}

      articleStats.forEach((stat) => {
        if (stat.status === 'ready') stats.ready = stat.count
        if (stat.status === 'sent') stats.sent = stat.count
        if (stat.status === 'judged') stats.judged = stat.count
      })

      return {
        ...job,
        articleStats: stats,
        totalTokenUsage: {
          totalTokens: Number(totalTokenUsage[0]?.totalTokens || 0),
          totalPromptTokens: Number(totalTokenUsage[0]?.totalPromptTokens || 0),
          totalCompletionTokens: Number(totalTokenUsage[0]?.totalCompletionTokens || 0),
        },
        tokenUsagePerDay: tokenUsagePerDay.map((row) => {
          return {
            ...row,
            dailyTokens: Number((row as any).dailyTokens || 0),
            dailyPromptTokens: Number((row as any).dailyPromptTokens || 0),
            dailyCompletionTokens: Number((row as any).dailyCompletionTokens || 0),
            requests: Number((row as any).requests || 0),
          }
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

      const count = await getUnassessedArticlesCount({
        db,
        projectId: job.projectId,
        projectModelId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
      })

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

      const unassessedArticles = await getUnassessedArticles({
        db,
        projectId: job.projectId,
        projectModelId,
        projectDateFrom,
        projectDateTo,
        importRouteIds,
      })

      return {data: unassessedArticles, error: null}
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get('/api/judgmentsjobs', async () => {
    const db = getDatabase()

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
      .leftJoin(projects, eq(judgmentsJobs.projectId, projects.id))
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
            t.Literal('paused_by_user'),
            t.Literal('paused_by_admin'),
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

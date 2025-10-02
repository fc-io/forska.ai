import {count, eq, gte, lte, sql} from 'drizzle-orm'
import type {SQL} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, judgmentsJobs, judgmentsJobsArticles, projects, prompts, tokenUse} from '../../db/schema'
import {getDatabase} from '../utils/getDatabase'
import {withErrorHandler} from '../utils/routeErrorHandler'

type Database = ReturnType<typeof getDatabase>

const buildProjectDateConditions = ({
  projectDateFrom,
  projectDateTo,
}: {
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
}): SQL[] => {
  const conditions: SQL[] = []

  if (projectDateFrom) {
    conditions.push(gte(articles.articleUpdatedAt, projectDateFrom))
  }

  if (projectDateTo) {
    conditions.push(lte(articles.articleUpdatedAt, projectDateTo))
  }

  return conditions
}

const buildProjectPromptCondition = (promptIds: string[]): SQL => {
  const promptArray = sql.join(
    promptIds.map((promptId) => {
      return sql`${promptId}::uuid`
    }),
    sql`,`,
  )

  return sql`EXISTS (
    SELECT 1 FROM ${prompts} p
    WHERE p.id = ANY(ARRAY[${promptArray}])
    AND NOT EXISTS (
      SELECT 1 FROM ${judgments} j
      WHERE j."article_id" = ${articles.id}
      AND j."prompt_id" = p.id
    )
  )`
}

const getUnassessedArticlesCount = async ({
  db,
  promptIds,
  projectDateFrom,
  projectDateTo,
}: {
  db: Database
  promptIds: string[]
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
}): Promise<number> => {
  if (promptIds.length === 0) {
    return 0
  }

  const whereClauses = [
    ...buildProjectDateConditions({projectDateFrom, projectDateTo}),
    buildProjectPromptCondition(promptIds),
  ]

  const [{count: unassessedCount = 0} = {count: 0}] = await db
    .select({count: count()})
    .from(articles)
    .where(sql`${sql.join(whereClauses, sql` AND `)}`)

  return unassessedCount
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

      const [jobWithProject] = await db
        .select({
          id: judgmentsJobs.id,
          createdAt: judgmentsJobs.createdAt,
          updatedAt: judgmentsJobs.updatedAt,
          projectId: judgmentsJobs.projectId,
          status: judgmentsJobs.status,
          error: judgmentsJobs.error,
          projectName: projects.name,
          projectDateFrom: projects.dateFrom,
          projectDateTo: projects.dateTo,
        })
        .from(judgmentsJobs)
        .leftJoin(projects, eq(judgmentsJobs.projectId, projects.id))
        .where(eq(judgmentsJobs.id, params.id))
        .limit(1)

      if (!jobWithProject) {
        throw new Error('Job not found')
      }

      const {projectDateFrom, projectDateTo, ...job} = jobWithProject

      const projectPrompts = await db
        .select({id: prompts.id})
        .from(prompts)
        .where(eq(prompts.projectId, job.projectId))

      // Get article statistics
      const articleStats = await db
        .select({status: judgmentsJobsArticles.status, count: sql<number>`count(*)::int`})
        .from(judgmentsJobsArticles)
        .where(eq(judgmentsJobsArticles.jobId, params.id))
        .groupBy(judgmentsJobsArticles.status)

      // Transform stats into a more usable format
      const stats = {ready: 0, sent: 0, judged: 0}

      articleStats.forEach((stat) => {
        if (stat.status === 'ready') stats.ready = stat.count
        if (stat.status === 'sent') stats.sent = stat.count
        if (stat.status === 'judged') stats.judged = stat.count
      })

      const unassessedCount = await getUnassessedArticlesCount({
        db,
        promptIds: projectPrompts.map((prompt) => {
          return prompt.id
        }),
        projectDateFrom,
        projectDateTo,
      })

      // Get total token usage for this job
      const totalTokenUsage = await db
        .select({
          totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)::int`,
          totalPromptTokens: sql<number>`COALESCE(SUM(total_prompt_tokens), 0)::int`,
          totalCompletionTokens: sql<number>`COALESCE(SUM(total_completion_tokens), 0)::int`,
        })
        .from(tokenUse)
        .where(eq(tokenUse.judgmentsJobId, params.id))

      // Get token usage per day for this job
      const tokenUsagePerDay = await db
        .select({
          date: sql<string>`DATE(created_at AT TIME ZONE 'UTC')`,
          dailyTokens: sql<number>`SUM(total_tokens)::int`,
          dailyPromptTokens: sql<number>`SUM(total_prompt_tokens)::int`,
          dailyCompletionTokens: sql<number>`SUM(total_completion_tokens)::int`,
          requests: sql<number>`SUM(requests)::int`,
        })
        .from(tokenUse)
        .where(eq(tokenUse.judgmentsJobId, params.id))
        .groupBy(sql`DATE(created_at AT TIME ZONE 'UTC')`)
        .orderBy(sql`DATE(created_at AT TIME ZONE 'UTC')`)

      return {
        ...job,
        articleStats: stats,
        unassessedArticlesCount: unassessedCount,
        totalTokenUsage: {
          totalTokens: totalTokenUsage[0]?.totalTokens || 0,
          totalPromptTokens: totalTokenUsage[0]?.totalPromptTokens || 0,
          totalCompletionTokens: totalTokenUsage[0]?.totalCompletionTokens || 0,
        },
        tokenUsagePerDay,
      }
    },
    {params: t.Object({id: t.String()})},
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

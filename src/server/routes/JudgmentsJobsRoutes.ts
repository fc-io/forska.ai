import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgmentsJobs, projects} from '../../db/schema'
import {getDatabase} from '../utils/getDatabase'
import {withErrorHandler} from '../utils/routeErrorHandler'

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

      console.log('Created judgments job:', job)

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
      console.log('Fetching job state for:', params.id)

      const [job] = await db
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
        .where(eq(judgmentsJobs.id, params.id))
        .limit(1)
      console.log('job:', job)

      if (!job) {
        throw new Error('Job not found')
      }
      return job
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

      console.log('Updated judgments job:', updatedJob.id, 'to status:', updatedJob.status)

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

      console.log('Deleted judgments job:', deletedJob.id)

      return {data: {jobId: deletedJob.id}, error: null}
    },
    {params: t.Object({id: t.String()})},
  )

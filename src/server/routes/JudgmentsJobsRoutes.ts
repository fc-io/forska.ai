import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgmentsJobs, projects} from '../../db/schema'
import {getDatabase} from '../utils/getDatabase'

export const judgmentsJobsRoutes = new Elysia()
  .post(
    '/api/judgmentsjobs',
    async ({body}) => {
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

      const [job] = await db
        .insert(judgmentsJobs)
        .values({projectId: body.projectId, status: 'running'})
        .returning()

      if (!job) {
        throw new Error('Failed to create judgments job')
      }

      console.log('Created judgments job:', job)

      return {
        data: {
          jobId: job.id,
          status: job.status,
          createdAt: job.createdAt,
          projectId: job.projectId,
        },
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

      if (!job) {
        return {error: 'Job not found', data: null}
      }

      return {
        data: {
          jobId: job.id,
          status: job.status,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          projectId: job.projectId,
          projectName: job.projectName,
          error: job.error,
        },
        error: null,
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .get('/api/judgmentsjobs', async () => {
    try {
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
    } catch (error) {
      console.error('Error fetching judgment jobs:', error)
      return {error: 'Failed to fetch judgment jobs', data: null}
    }
  })
  .patch(
    '/api/judgmentsjobs/:id',
    async ({params, body}) => {
      try {
        const db = getDatabase()

        const [updatedJob] = await db
          .update(judgmentsJobs)
          .set({status: body.status, error: body.error, updatedAt: new Date()})
          .where(eq(judgmentsJobs.id, params.id))
          .returning()

        if (!updatedJob) {
          return {error: 'Job not found', data: null}
        }

        console.log(
          'Updated judgments job:',
          updatedJob.id,
          'to status:',
          updatedJob.status,
        )

        return {
          data: {
            jobId: updatedJob.id,
            status: updatedJob.status,
            updatedAt: updatedJob.updatedAt,
            error: updatedJob.error,
          },
          error: null,
        }
      } catch (error) {
        console.error('Error updating judgment job:', error)
        return {error: 'Failed to update judgment job', data: null}
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
      try {
        const db = getDatabase()

        const [deletedJob] = await db
          .delete(judgmentsJobs)
          .where(eq(judgmentsJobs.id, params.id))
          .returning({id: judgmentsJobs.id})

        if (!deletedJob) {
          return {error: 'Job not found', data: null}
        }

        console.log('Deleted judgments job:', deletedJob.id)

        return {data: {jobId: deletedJob.id}, error: null}
      } catch (error) {
        console.error('Error deleting judgment job:', error)
        return {error: 'Failed to delete judgment job', data: null}
      }
    },
    {params: t.Object({id: t.String()})},
  )

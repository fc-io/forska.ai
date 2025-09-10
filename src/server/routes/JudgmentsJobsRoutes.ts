import {Elysia, t} from 'elysia'

type JobState = 'pending' | 'processing' | 'completed' | 'failed'

type JudgmentsJob = {
  id: string
  state: JobState
  createdAt: Date
  projectId: string
  agentConfig?: unknown
}

const generateJobId = () => {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export const judgmentsJobsRoutes = new Elysia()
  .post(
    '/api/judgmentsjobs',
    async ({body}) => {
      const jobId = generateJobId()

      const job: JudgmentsJob = {
        id: jobId,
        state: 'processing',
        createdAt: new Date(),
        projectId: body.projectId,
        agentConfig: body.agentConfig,
      }

      console.log('Creating judgments job:', job)

      return {jobId: job.id, state: job.state}
    },
    {body: t.Object({projectId: t.String(), agentConfig: t.Optional(t.Any())})},
  )
  .get(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      console.log('Checking job state for:', params.id)

      return {
        jobId: params.id,
        state: 'processing' as JobState,
        createdAt: new Date(),
      }
    },
    {params: t.Object({id: t.String()})},
  )

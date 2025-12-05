import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {getMaxNumberOfInflightRequests} from './getMaxNumberOfInflightRequests.ts'
import {judgmentsJobsCronGetArticles} from './judgmentsJobsCronGetArticles.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>[number]

const getCountOfReadyArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  jobId: string,
): Promise<number> => {
  const result = await db
    .select({count: count()})
    .from(schema.judgmentsJobsArticles)
    .where(
      and(
        eq(schema.judgmentsJobsArticles.status, 'ready'),
        eq(schema.judgmentsJobsArticles.serverId, serverJobId),
        eq(schema.judgmentsJobsArticles.jobId, jobId),
      ),
    )

  return result[0]?.count ?? 0
}

const needsMorePrompts = (readyCount: number): boolean => {
  return readyCount < getMaxNumberOfInflightRequests() * 20
}

const addPromptsToQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  promptIds: string[],
  serverJobId: string,
): Promise<void> => {
  if (promptIds.length === 0) return

  await db.insert(schema.judgmentsJobsArticles).values(
    promptIds.map((articleId) => {
      return {jobId, articleId, status: 'ready' as const, serverId: serverJobId}
    }),
  )
}

const fetchPromptsForJob = async (job: Job, numberOfPromptsToGet: number) => {
  const promptData = await judgmentsJobsCronGetArticles(job.projectId, job.id, numberOfPromptsToGet)
  return {...promptData, job}
}

const getNewPromptsForJob = async (
  db: PostgresJsDatabase<typeof schema>,
  job: Job,
  serverJobId: string,
  promptsPerJob: number,
) => {
  const countOfReadyArticles = await getCountOfReadyArticles(db, serverJobId, job.id)
  return needsMorePrompts(countOfReadyArticles)
    ? fetchPromptsForJob(job, promptsPerJob)
    : {promptIds: [], prompts: [], projectPrompts: [], job}
}

export const judgmentsJobsAddToQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  const {SGLANG_MAX_RUNNING_REQUESTS} = env
  const promptsPerJob = Math.max(1, Number(SGLANG_MAX_RUNNING_REQUESTS || 1) * 5)
  const runningJobs = await judgmentsJobsGetRunningJobs(db)

  await Promise.all(
    runningJobs.map(async (job) => {
      const {promptIds} = await getNewPromptsForJob(db, job, serverJobId, promptsPerJob)
      await addPromptsToQueue(db, job.id, promptIds, serverJobId)
    }),
  )
}

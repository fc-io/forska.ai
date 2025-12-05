import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {getMaxNumberOfInflightRequests} from './getMaxNumberOfInflightRequests.ts'
import {judgmentsJobsCronGetPrompts} from './judgmentsJobsCronGetPrompts.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>[number]

/** Counts the number of prompts in 'ready' status for a given job and server */
const getCountOfReadyPrompts = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  jobId: string,
): Promise<number> => {
  const result = await db
    .select({count: count()})
    .from(schema.judgmentsJobsPrompts)
    .where(
      and(
        eq(schema.judgmentsJobsPrompts.status, 'ready'),
        eq(schema.judgmentsJobsPrompts.serverId, serverJobId),
        eq(schema.judgmentsJobsPrompts.jobId, jobId),
      ),
    )

  return result[0]?.count ?? 0
}

const needsMorePrompts = (readyCount: number): boolean => {
  return readyCount < getMaxNumberOfInflightRequests() * 20
}

type PromptQueueEntry = {articleId: string; promptId: string}

const addPromptsToQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  promptEntries: PromptQueueEntry[],
  serverJobId: string,
): Promise<void> => {
  if (promptEntries.length === 0) return

  await db.insert(schema.judgmentsJobsPrompts).values(
    promptEntries.map((entry) => {
      return {
        jobId,
        articleId: entry.articleId,
        promptId: entry.promptId,
        status: 'ready' as const,
        serverId: serverJobId,
      }
    }),
  )
}

const fetchPromptsForJob = async (job: Job, numberOfPromptsToGet: number) => {
  const promptData = await judgmentsJobsCronGetPrompts(job.projectId, job.id, numberOfPromptsToGet)
  return {...promptData, job}
}

const getNewPromptsForJob = async (
  db: PostgresJsDatabase<typeof schema>,
  job: Job,
  serverJobId: string,
  promptsPerJob: number,
) => {
  const countOfReadyPrompts = await getCountOfReadyPrompts(db, serverJobId, job.id)
  return needsMorePrompts(countOfReadyPrompts) ? fetchPromptsForJob(job, promptsPerJob) : {promptEntries: [], job}
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
      const {promptEntries} = await getNewPromptsForJob(db, job, serverJobId, promptsPerJob)
      await addPromptsToQueue(db, job.id, promptEntries, serverJobId)
    }),
  )
}

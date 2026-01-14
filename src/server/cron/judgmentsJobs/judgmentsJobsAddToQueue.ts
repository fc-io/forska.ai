import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {judgmentsJobsCronGetPrompts} from './judgmentsJobsCronGetPrompts.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>[number]

/** Counts the number of prompts in 'ready' status for a given job */
const getCountOfReadyPrompts = async (db: PostgresJsDatabase<typeof schema>, jobId: string): Promise<number> => {
  const result = await db
    .select({count: count()})
    .from(schema.judgmentsJobsPrompts)
    .where(and(eq(schema.judgmentsJobsPrompts.status, 'ready'), eq(schema.judgmentsJobsPrompts.jobId, jobId)))

  return result[0]?.count ?? 0
}

const getPromptsToFetchCount = (
  readyCount: number,
  readyTargetPerJob: number,
  addToQueueMaxBatchSize: number,
): number => {
  const deficit = Math.max(0, readyTargetPerJob - readyCount)
  return Math.min(deficit, addToQueueMaxBatchSize)
}

type PromptQueueEntry = {articleId: string; promptId: string}

// PostgreSQL has a limit of ~65535 parameters per query.
// With 5 columns per row, we can safely insert up to 10000 rows per batch.
const BATCH_INSERT_SIZE = 10000

const addPromptsToQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  promptEntries: PromptQueueEntry[],
  serverJobId: string,
): Promise<void> => {
  if (promptEntries.length === 0) return

  // Chunk the entries to avoid exceeding PostgreSQL's parameter limit
  for (let i = 0; i < promptEntries.length; i += BATCH_INSERT_SIZE) {
    const chunk = promptEntries.slice(i, i + BATCH_INSERT_SIZE)
    await db.insert(schema.judgmentsJobsPrompts).values(
      chunk.map((entry) => {
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
}

const fetchPromptsForJob = async (job: Job, numberOfPromptsToGet: number) => {
  const promptData = await judgmentsJobsCronGetPrompts(job.projectId, job.id, numberOfPromptsToGet)
  return {...promptData, job}
}

const getNewPromptsForJob = async (
  db: PostgresJsDatabase<typeof schema>,
  job: Job,
  readyTargetPerJob: number,
  addToQueueMaxBatchSize: number,
) => {
  const countOfReadyPrompts = await getCountOfReadyPrompts(db, job.id)
  const promptsToFetchCount = getPromptsToFetchCount(countOfReadyPrompts, readyTargetPerJob, addToQueueMaxBatchSize)
  return promptsToFetchCount > 0 ? fetchPromptsForJob(job, promptsToFetchCount) : {promptEntries: [], job}
}

export const judgmentsJobsAddToQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  const runningJobs = await judgmentsJobsGetRunningJobs(db)
  const capacity = getJudgmentsCapacity(runningJobs.length)

  await Promise.all(
    runningJobs.map(async (job) => {
      const {promptEntries} = await getNewPromptsForJob(
        db,
        job,
        capacity.readyTargetPerJob,
        capacity.addToQueueMaxBatchSize,
      )
      await addPromptsToQueue(db, job.id, promptEntries, serverJobId)
    }),
  )
}

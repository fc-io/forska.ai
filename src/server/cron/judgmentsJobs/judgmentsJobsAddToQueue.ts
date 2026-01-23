import {and, count, eq, inArray, isNull, or} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {judgmentsJobsCronGetPrompts} from './judgmentsJobsCronGetPrompts.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>[number]

type JobConfig = {
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

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

/** Filter out prompt entries that already have judgments in PostgreSQL */
const filterAlreadyJudged = async (
  db: PostgresJsDatabase<typeof schema>,
  promptEntries: PromptQueueEntry[],
  jobConfig: JobConfig,
): Promise<PromptQueueEntry[]> => {
  if (promptEntries.length === 0) return []

  // Check in batches to avoid query size limits
  const BATCH_SIZE = 1000
  const filtered: PromptQueueEntry[] = []

  for (let i = 0; i < promptEntries.length; i += BATCH_SIZE) {
    const batch = promptEntries.slice(i, i + BATCH_SIZE)

    // Build conditions for each article/prompt pair
    const pairConditions = batch.map((entry) =>
      and(eq(schema.judgments.articleId, entry.articleId), eq(schema.judgments.promptId, entry.promptId)),
    )

    // Find which pairs already have judgments
    const existingJudgments = await db
      .select({articleId: schema.judgments.articleId, promptId: schema.judgments.promptId})
      .from(schema.judgments)
      .where(
        and(
          or(...pairConditions),
          eq(schema.judgments.modelId, jobConfig.modelId),
          eq(schema.judgments.useTitle, jobConfig.useTitle),
          eq(schema.judgments.useAbstract, jobConfig.useAbstract),
          eq(schema.judgments.useFulltext, jobConfig.useFulltext),
          eq(schema.judgments.useFulltextNoImages, jobConfig.useFulltextNoImages),
          isNull(schema.judgments.deletedAt),
        ),
      )

    const existingSet = new Set(existingJudgments.map((j) => `${j.articleId}:${j.promptId}`))

    const notJudged = batch.filter((entry) => !existingSet.has(`${entry.articleId}:${entry.promptId}`))
    filtered.push(...notJudged)
  }

  const skipped = promptEntries.length - filtered.length
  if (skipped > 0) {
    console.log(`[addToQueue] Filtered out ${skipped} already-judged entries (ClickHouse replication lag)`)
  }

  return filtered
}

const addPromptsToQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  promptEntries: PromptQueueEntry[],
  serverJobId: string,
): Promise<void> => {
  if (promptEntries.length === 0) return

  // Chunk the entries to avoid exceeding PostgreSQL's parameter limit
  // Use onConflictDoNothing because ClickHouse query cannot check queue table
  // (judgments_jobs_prompts is not replicated to CH)
  for (let i = 0; i < promptEntries.length; i += BATCH_INSERT_SIZE) {
    const chunk = promptEntries.slice(i, i + BATCH_INSERT_SIZE)
    await db
      .insert(schema.judgmentsJobsPrompts)
      .values(
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
      .onConflictDoNothing()
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

const getJobConfig = async (db: PostgresJsDatabase<typeof schema>, jobId: string): Promise<JobConfig | null> => {
  const [config] = await db
    .select({
      modelId: schema.projects.modelId,
      useTitle: schema.projects.useTitle,
      useAbstract: schema.projects.useAbstract,
      useFulltext: schema.projects.useFulltext,
      useFulltextNoImages: schema.projects.useFulltextNoImages,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
    .where(eq(schema.judgmentsJobs.id, jobId))
    .limit(1)

  if (!config?.modelId) return null
  return config as JobConfig
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

      // Filter out entries that already have judgments in PostgreSQL
      // This handles ClickHouse replication lag - CH may return pairs that were just judged
      const jobConfig = await getJobConfig(db, job.id)
      if (!jobConfig) {
        console.error('[addToQueue] Job config not found for jobId:', job.id)
        return
      }

      const filteredEntries = await filterAlreadyJudged(db, promptEntries, jobConfig)
      await addPromptsToQueue(db, job.id, filteredEntries, serverJobId)
    }),
  )
}

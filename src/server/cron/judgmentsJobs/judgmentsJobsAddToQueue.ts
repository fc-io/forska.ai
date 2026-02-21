import {and, count, eq, isNull, or} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {clearJobCursor, setJobCursor} from './jobCursorStore.ts'
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

const addToQueueLogger = createRateLimitedLogger({windowMs: 30_000})

const getCodexMaxInflight = (): number => {
  const raw = Number(process.env.CODEX_MAX_INFLIGHT)
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 0
  return n > 0 ? n : 1
}

const getCodexQueueTargets = (runningJobCount: number) => {
  const maxInflight = getCodexMaxInflight()
  const readyTargetMultiplier = Math.max(1, Number(process.env.JUDGMENTS_READY_TARGET_MULTIPLIER ?? 10))
  const readyTargetTotal = maxInflight * readyTargetMultiplier
  const normalizedJobCount = Math.max(1, runningJobCount)
  const readyTargetPerJob = Math.max(1, Math.ceil(readyTargetTotal / normalizedJobCount))
  const envMaxBatch = Math.max(1, Number(process.env.JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE ?? 10000))
  const addToQueueMaxBatchSize = Math.min(envMaxBatch, 2000)
  return {readyTargetPerJob, addToQueueMaxBatchSize}
}

const getJobProvider = (job: Job): string => {
  const raw = (job as {modelProvider?: unknown}).modelProvider
  return typeof raw === 'string' ? raw : ''
}

const isCodexJob = (job: Job): boolean => {
  return getJobProvider(job).trim().toLowerCase() === 'codex'
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
    const pairConditions = batch.map((entry) => {
      return and(eq(schema.judgments.articleId, entry.articleId), eq(schema.judgments.promptId, entry.promptId))
    })

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

    const existingSet = new Set(
      existingJudgments.map((j) => {
        return `${j.articleId}:${j.promptId}`
      }),
    )

    const notJudged = batch.filter((entry) => {
      return !existingSet.has(`${entry.articleId}:${entry.promptId}`)
    })
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

const updateJobCursorAfterFetch = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  nextCursor: Awaited<ReturnType<typeof judgmentsJobsCronGetPrompts>>['nextCursor'],
): Promise<void> => {
  return nextCursor ? setJobCursor(db, jobId, nextCursor) : clearJobCursor(db, jobId)
}

const getNewPromptsForJob = async (
  db: PostgresJsDatabase<typeof schema>,
  job: Job,
  readyTargetPerJob: number,
  addToQueueMaxBatchSize: number,
) => {
  const countOfReadyPrompts = await getCountOfReadyPrompts(db, job.id)
  const promptsToFetchCount = getPromptsToFetchCount(countOfReadyPrompts, readyTargetPerJob, addToQueueMaxBatchSize)
  const didFetch = promptsToFetchCount > 0
  const result = didFetch ? await fetchPromptsForJob(job, promptsToFetchCount) : {promptEntries: [], nextCursor: null}
  return {
    promptEntries: result.promptEntries,
    nextCursor: result.nextCursor,
    didFetch,
    job,
    countOfReadyPrompts,
    promptsToFetchCount,
  }
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
  const codexJobs = runningJobs.filter(isCodexJob)
  const nonCodexJobs = runningJobs.filter((job) => {
    return !isCodexJob(job)
  })

  const nonCodexCapacity = getJudgmentsCapacity(nonCodexJobs.length)
  const codexTargets = getCodexQueueTargets(codexJobs.length)

  addToQueueLogger.log('addToQueue:tick', '[addToQueue] tick', {
    serverJobId,
    jobCount: runningJobs.length,
    nonCodexJobCount: nonCodexJobs.length,
    codexJobCount: codexJobs.length,
    nonCodexReadyTargetPerJob: nonCodexCapacity.readyTargetPerJob,
    codexReadyTargetPerJob: codexTargets.readyTargetPerJob,
  })

  const addForJobs = async (jobs: Job[], readyTargetPerJob: number, addToQueueMaxBatchSize: number) => {
    await Promise.all(
      jobs.map(async (job) => {
        const getNewStartMs = Date.now()
        const {countOfReadyPrompts, didFetch, nextCursor, promptEntries, promptsToFetchCount} =
          await getNewPromptsForJob(db, job, readyTargetPerJob, addToQueueMaxBatchSize)
        const getNewMs = Date.now() - getNewStartMs

        if (promptsToFetchCount > 0 && promptEntries.length === 0) {
          addToQueueLogger.warn(`addToQueue:job:${job.id}:empty`, '[addToQueue] got 0 pairs from ClickHouse', {
            jobId: job.id,
            projectId: job.projectId,
            ready: countOfReadyPrompts,
            readyTargetPerJob,
            requested: promptsToFetchCount,
            ms: getNewMs,
          })
        }

        if (promptsToFetchCount > 0 || getNewMs > 5_000) {
          addToQueueLogger.log(`addToQueue:job:${job.id}`, '[addToQueue] top-up check', {
            jobId: job.id,
            projectId: job.projectId,
            ready: countOfReadyPrompts,
            readyTargetPerJob,
            requested: promptsToFetchCount,
            fetched: promptEntries.length,
            ms: getNewMs,
          })
        }

        // Filter out entries that already have judgments in PostgreSQL
        // This handles ClickHouse replication lag - CH may return pairs that were just judged
        const jobConfig = await getJobConfig(db, job.id)
        if (!jobConfig) {
          console.error('[addToQueue] Job config not found for jobId:', job.id)
          return
        }

        const filterStartMs = Date.now()
        const filteredEntries = await filterAlreadyJudged(db, promptEntries, jobConfig)
        const filterMs = Date.now() - filterStartMs

        if (promptEntries.length > 0 && (filteredEntries.length === 0 || filterMs > 5_000)) {
          addToQueueLogger.warn(`addToQueue:job:${job.id}:filtered`, '[addToQueue] filtered pairs', {
            jobId: job.id,
            projectId: job.projectId,
            before: promptEntries.length,
            after: filteredEntries.length,
            ms: filterMs,
          })
        }

        const insertStartMs = Date.now()
        await addPromptsToQueue(db, job.id, filteredEntries, serverJobId)
        const insertMs = Date.now() - insertStartMs

        if (didFetch) {
          const cursorUpdateStartMs = Date.now()
          await updateJobCursorAfterFetch(db, job.id, nextCursor)
          const cursorUpdateMs = Date.now() - cursorUpdateStartMs

          if (cursorUpdateMs > 5_000) {
            addToQueueLogger.warn(`addToQueue:job:${job.id}:cursor`, '[addToQueue] slow cursor update', {
              jobId: job.id,
              projectId: job.projectId,
              ms: cursorUpdateMs,
            })
          }
        }

        if (filteredEntries.length > 0 && insertMs > 5_000) {
          addToQueueLogger.warn(`addToQueue:job:${job.id}:insert`, '[addToQueue] slow insert', {
            jobId: job.id,
            projectId: job.projectId,
            attempted: filteredEntries.length,
            ms: insertMs,
          })
        }
      }),
    )
  }
  await addForJobs(nonCodexJobs, nonCodexCapacity.readyTargetPerJob, nonCodexCapacity.addToQueueMaxBatchSize)
  await addForJobs(codexJobs, codexTargets.readyTargetPerJob, codexTargets.addToQueueMaxBatchSize)
}

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {env} from '../../utils/env.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
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

const getCodexQueueTargets = (runningJobCount: number) => {
  const maxInflight = getCodexMaxInflight()
  const readyTargetMultiplier = Math.max(1, env.JUDGMENTS_READY_TARGET_MULTIPLIER)
  const readyTargetTotal = maxInflight * readyTargetMultiplier
  const normalizedJobCount = Math.max(1, runningJobCount)
  const readyTargetPerJob = Math.max(1, Math.ceil(readyTargetTotal / normalizedJobCount))
  const envMaxBatch = Math.max(1, env.JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE)
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
const getCountOfReadyPrompts = async (jobId: string): Promise<number> => {
  const result = await getAppDatabaseService().queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_job_prompt
    WHERE status = 'ready'
      AND job_id = '${escapeSqlString(jobId)}'
  `)

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

// Keep insert batches bounded to avoid oversized statements and parameter lists.
const BATCH_INSERT_SIZE = 10000

/** Filter out prompt entries that already have judgments in the app database */
const filterAlreadyJudged = async (
  promptEntries: PromptQueueEntry[],
  jobConfig: JobConfig,
): Promise<PromptQueueEntry[]> => {
  if (promptEntries.length === 0) return []

  // Check in batches to avoid query size limits
  const BATCH_SIZE = 1000
  const filtered: PromptQueueEntry[] = []

  for (let i = 0; i < promptEntries.length; i += BATCH_SIZE) {
    const batch = promptEntries.slice(i, i + BATCH_SIZE)

    // Find which pairs already have judgments
    const existingJudgments = await getAppDatabaseService().queryJson<{articleId: string; promptId: string}>(`
      WITH pairs(article_id, prompt_id) AS (
        VALUES ${batch
          .map((entry) => {
            return `(${getQuotedStringList([entry.articleId, entry.promptId]).join(', ')})`
          })
          .join(', ')}
      )
      SELECT j.article_id AS articleId, j.prompt_id AS promptId
      FROM app.judgment j
      INNER JOIN pairs p ON p.article_id = j.article_id AND p.prompt_id = j.prompt_id
      WHERE j.model_id = ${getSqlLiteral(jobConfig.modelId)}
        AND j.use_title = ${getSqlLiteral(jobConfig.useTitle)}
        AND j.use_abstract = ${getSqlLiteral(jobConfig.useAbstract)}
        AND j.use_fulltext = ${getSqlLiteral(jobConfig.useFulltext)}
        AND j.use_fulltext_no_images = ${getSqlLiteral(jobConfig.useFulltextNoImages)}
        AND j.deleted_at IS NULL
    `)

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
    console.log(`[addToQueue] Filtered out ${skipped} already-judged entries after queue refresh`)
  }

  return filtered
}

const addPromptsToQueue = async (
  jobId: string,
  promptEntries: PromptQueueEntry[],
  serverJobId: string,
): Promise<void> => {
  if (promptEntries.length === 0) return

  // Chunk the entries to keep insert statements bounded
  // Use onConflictDoNothing because queued entries may race with newly written judgments.
  for (let i = 0; i < promptEntries.length; i += BATCH_INSERT_SIZE) {
    const chunk = promptEntries.slice(i, i + BATCH_INSERT_SIZE)
    await getAppDatabaseService().run(`
      INSERT INTO app.judgment_job_prompt (id, job_id, article_id, prompt_id, status, server_id)
      VALUES ${chunk
        .map((entry) => {
          return `(${getQuotedStringList([crypto.randomUUID(), jobId, entry.articleId, entry.promptId, 'ready', serverJobId]).join(', ')})`
        })
        .join(', ')}
      ON CONFLICT(article_id, prompt_id, job_id) DO NOTHING
    `)
  }
}

const fetchPromptsForJob = async (job: Job, numberOfPromptsToGet: number) => {
  const promptData = await judgmentsJobsCronGetPrompts(job.projectId, job.id, numberOfPromptsToGet)
  return {...promptData, job}
}

const updateJobCursorAfterFetch = async (
  jobId: string,
  nextCursor: Awaited<ReturnType<typeof judgmentsJobsCronGetPrompts>>['nextCursor'],
): Promise<void> => {
  return nextCursor ? setJobCursor(jobId, nextCursor) : clearJobCursor(jobId)
}

const getNewPromptsForJob = async (job: Job, readyTargetPerJob: number, addToQueueMaxBatchSize: number) => {
  const countOfReadyPrompts = await getCountOfReadyPrompts(job.id)
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

const getJobConfig = async (jobId: string): Promise<JobConfig | null> => {
  const [config] = await getAppDatabaseService().queryJson<JobConfig>(`
    SELECT
      p.model_id AS modelId,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM app.judgment_job jj
    INNER JOIN app.project p ON p.id = jj.project_id
    WHERE jj.id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  if (!config?.modelId) return null
  return config
}

type AddToQueueJobParams = {job: Job; readyTargetPerJob: number; addToQueueMaxBatchSize: number; serverJobId: string}

const addToQueueForJob = async (params: AddToQueueJobParams): Promise<void> => {
  const {job, readyTargetPerJob, addToQueueMaxBatchSize, serverJobId} = params
  const getNewStartMs = Date.now()
  const {countOfReadyPrompts, didFetch, nextCursor, promptEntries, promptsToFetchCount} = await getNewPromptsForJob(
    job,
    readyTargetPerJob,
    addToQueueMaxBatchSize,
  )
  const getNewMs = Date.now() - getNewStartMs

  if (promptsToFetchCount > 0 && promptEntries.length === 0) {
    addToQueueLogger.warn(`addToQueue:job:${job.id}:empty`, '[addToQueue] got 0 pairs from olap', {
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

  const jobConfig = await getJobConfig(job.id)
  if (!jobConfig) {
    console.error('[addToQueue] Job config not found for jobId:', job.id)
    return
  }

  const filterStartMs = Date.now()
  const filteredEntries = await filterAlreadyJudged(promptEntries, jobConfig)
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
  await addPromptsToQueue(job.id, filteredEntries, serverJobId)
  const insertMs = Date.now() - insertStartMs

  if (didFetch) {
    const cursorUpdateStartMs = Date.now()
    await updateJobCursorAfterFetch(job.id, nextCursor)
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
}

export const judgmentsJobsAddToQueue = async (serverJobId: string): Promise<void> => {
  const runningJobs = await judgmentsJobsGetRunningJobs()
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
    await jobs.reduce(async (prev, job) => {
      await prev
      await addToQueueForJob({job, readyTargetPerJob, addToQueueMaxBatchSize, serverJobId})
    }, Promise.resolve())
  }
  await addForJobs(nonCodexJobs, nonCodexCapacity.readyTargetPerJob, nonCodexCapacity.addToQueueMaxBatchSize)
  await addForJobs(codexJobs, codexTargets.readyTargetPerJob, codexTargets.addToQueueMaxBatchSize)
}

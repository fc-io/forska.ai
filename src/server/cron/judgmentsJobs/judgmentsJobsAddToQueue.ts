import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {inferenceRuntimeConfig} from '../../utils/getInferenceRuntimeConfig.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'
import {judgmentsJobsCronGetPrompts} from './judgmentsJobsCronGetPrompts.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobsGetRunningJobs.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>[number]

type JobConfig = {
  humanJudgmentMode: 'prompt' | 'summary'
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

const addToQueueLogger = createRateLimitedLogger({windowMs: 30_000})
const sqliteScanOverscanMultiplier = 5
const sqliteScanMaxWindowsPerTick = 5
const sqliteScanExhaustedCooldownMs = 60_000

const getCodexQueueTargets = (runningJobCount: number) => {
  const maxInflight = getCodexMaxInflight()
  const readyTargetMultiplier = Math.max(1, inferenceRuntimeConfig.judgmentsReadyTargetMultiplier)
  const readyTargetTotal = maxInflight * readyTargetMultiplier
  const normalizedJobCount = Math.max(1, runningJobCount)
  const readyTargetPerJob = Math.max(1, Math.ceil(readyTargetTotal / normalizedJobCount))
  const envMaxBatch = Math.max(1, inferenceRuntimeConfig.judgmentsAddToQueueMaxBatchSize)
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

const getPromptsToFetchCount = (
  readyCount: number,
  readyTargetPerJob: number,
  addToQueueMaxBatchSize: number,
): number => {
  const deficit = Math.max(0, readyTargetPerJob - readyCount)
  return Math.min(deficit, addToQueueMaxBatchSize)
}

type PromptQueueEntry = {articleId: string; promptId: string}

const sqliteBatchSize = 1000

const getPromptQueueEntryKey = (entry: PromptQueueEntry) => {
  return `${entry.articleId}:${entry.promptId}`
}

const getPromptQueueEntryArticleIdBatches = (entries: PromptQueueEntry[]) => {
  return entries
    .reduce<{articleIds: string[]; seenArticleIds: Set<string>}>(
      (state, entry) => {
        if (state.seenArticleIds.has(entry.articleId)) {
          return state
        }

        state.articleIds.push(entry.articleId)
        state.seenArticleIds.add(entry.articleId)

        return state
      },
      {articleIds: [], seenArticleIds: new Set<string>()},
    )
    .articleIds.reduce<string[][]>((batches, articleId, index) => {
      const batchIndex = Math.floor(index / sqliteBatchSize)
      const batch = batches[batchIndex] ?? []

      batch.push(articleId)
      batches[batchIndex] = batch

      return batches
    }, [])
}

const getPromptQueueEntryBatches = (entries: PromptQueueEntry[]) => {
  return entries.reduce<PromptQueueEntry[][]>((batches, entry, index) => {
    const batchIndex = Math.floor(index / sqliteBatchSize)
    const batch = batches[batchIndex] ?? []

    batch.push(entry)
    batches[batchIndex] = batch

    return batches
  }, [])
}

const getAnsweredHumanPromptPairKeys = async (
  promptEntries: PromptQueueEntry[],
  projectId: string,
): Promise<Set<string>> => {
  const batches = getPromptQueueEntryBatches(promptEntries)
  const matchingRows = await Promise.all(
    batches.map(async (batch) => {
      return getAppDatabaseService().queryJson<{articleId: string; promptId: string}>(`
        WITH pairs(article_id, prompt_id) AS (
          VALUES ${batch
            .map((entry) => {
              return `(${getSqlLiteral(entry.articleId)}, ${getSqlLiteral(entry.promptId)})`
            })
            .join(', ')}
        )
        SELECT DISTINCT jh.article_id AS articleId, jh.prompt_id AS promptId
        FROM app.judgment_human jh
        INNER JOIN pairs p ON p.article_id = jh.article_id AND p.prompt_id = jh.prompt_id
        WHERE jh.project_id = ${getSqlLiteral(projectId)}
          AND jh.is_answered = TRUE
      `)
    }),
  )

  return new Set(
    matchingRows.flatMap((rows) => {
      return rows.map((entry) => {
        return getPromptQueueEntryKey(entry)
      })
    }),
  )
}

const getAnsweredHumanSummaryArticleIds = async (
  promptEntries: PromptQueueEntry[],
  projectId: string,
): Promise<Set<string>> => {
  const batches = getPromptQueueEntryArticleIdBatches(promptEntries)
  const matchingRows = await Promise.all(
    batches.map(async (batch) => {
      return getAppDatabaseService().queryJson<{articleId: string}>(`
        SELECT DISTINCT article_id AS articleId
        FROM app.judgment_human_summary
        WHERE project_id = ${getSqlLiteral(projectId)}
          AND article_id IN (${batch
            .map((articleId) => {
              return getSqlLiteral(articleId)
            })
            .join(', ')})
          AND NULLIF(TRIM(COALESCE(answer, '')), '') IS NOT NULL
      `)
    }),
  )

  return new Set(
    matchingRows.flatMap((rows) => {
      return rows.map((entry) => {
        return entry.articleId
      })
    }),
  )
}

const partitionPromptQueueEntriesByHumanAnswered = (
  promptEntries: PromptQueueEntry[],
  answeredHumanPairKeys: Set<string>,
) => {
  return promptEntries.reduce<{humanFirst: PromptQueueEntry[]; rest: PromptQueueEntry[]}>(
    (state, entry) => {
      const target = answeredHumanPairKeys.has(getPromptQueueEntryKey(entry)) ? state.humanFirst : state.rest

      target.push(entry)

      return state
    },
    {humanFirst: [], rest: []},
  )
}

const partitionPromptQueueEntriesByHumanSummaryAnswered = (
  promptEntries: PromptQueueEntry[],
  answeredHumanSummaryArticleIds: Set<string>,
) => {
  return promptEntries.reduce<{humanFirst: PromptQueueEntry[]; rest: PromptQueueEntry[]}>(
    (state, entry) => {
      const target = answeredHumanSummaryArticleIds.has(entry.articleId) ? state.humanFirst : state.rest

      target.push(entry)

      return state
    },
    {humanFirst: [], rest: []},
  )
}

/** Filter out prompt entries that already have judgments in the app database */
const filterAlreadyJudged = async (
  promptEntries: PromptQueueEntry[],
  jobConfig: JobConfig,
  jobId: string,
): Promise<PromptQueueEntry[]> => {
  if (promptEntries.length === 0) return []

  const sqliteService = getJudgmentJobSqliteService()

  const filtered: PromptQueueEntry[] = []

  for (let i = 0; i < promptEntries.length; i += sqliteBatchSize) {
    const batch = promptEntries.slice(i, i + sqliteBatchSize)

    // Find which pairs already have judgments
    const existingJudgments = await getAppDatabaseService().queryJson<{articleId: string; promptId: string}>(`
      WITH pairs(article_id, prompt_id) AS (
        VALUES ${batch
          .map((entry) => {
            return `(${getSqlLiteral(entry.articleId)}, ${getSqlLiteral(entry.promptId)})`
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
        return getPromptQueueEntryKey(j)
      }),
    )

    const notJudged = batch.filter((entry) => {
      return !existingSet.has(getPromptQueueEntryKey(entry))
    })
    filtered.push(...notJudged)
  }

  const skipped = promptEntries.length - filtered.length
  if (skipped > 0) {
    console.log(`[addToQueue] Filtered out ${skipped} already-judged entries after queue refresh`)
  }

  const filteredForLocalJudgments = await sqliteService.filterOutLocallyJudgedPrompts(jobId, filtered)

  const locallySkipped = filtered.length - filteredForLocalJudgments.length
  if (locallySkipped > 0) {
    console.log(`[addToQueue] Filtered out ${locallySkipped} locally-judged SQLite entries after queue refresh`)
  }

  return filteredForLocalJudgments
}

const getSqliteWindowSize = (readyDeficit: number, addToQueueMaxBatchSize: number) => {
  return Math.min(
    addToQueueMaxBatchSize * sqliteScanOverscanMultiplier,
    Math.max(readyDeficit, readyDeficit * sqliteScanOverscanMultiplier),
  )
}

const getInsertedReadyCount = async ({
  filteredEntries,
  humanFirstEntries,
  jobId,
  readyDeficit,
  serverJobId,
  sqliteService,
}: {
  filteredEntries: PromptQueueEntry[]
  humanFirstEntries: PromptQueueEntry[]
  jobId: string
  readyDeficit: number
  serverJobId: string
  sqliteService: ReturnType<typeof getJudgmentJobSqliteService>
}) => {
  const insertableHumanFirstEntries =
    humanFirstEntries.length > 0 ? await sqliteService.filterOutExistingQueuedPrompts(jobId, humanFirstEntries) : []
  const insertedCount = await sqliteService.addReadyPrompts(jobId, filteredEntries, serverJobId, readyDeficit)

  if (humanFirstEntries.length > 0) {
    const insertedHumanFirstCount = Math.min(insertedCount, readyDeficit, insertableHumanFirstEntries.length)

    console.log(
      `[addToQueue] Prioritized ${humanFirstEntries.length} answered human entries and inserted ${insertedHumanFirstCount}`,
    )
  }

  return insertedCount
}

const hasSqliteExhaustedCooldown = (exhaustedAt: Date | null) => {
  return exhaustedAt ? Date.now() - exhaustedAt.getTime() < sqliteScanExhaustedCooldownMs : false
}

const getProjectDirtyToken = async (jobId: string): Promise<number | null> => {
  const [row] = await getAppDatabaseService().queryJson<{dirtyToken: number | null}>(`
    SELECT CAST(pmrs.dirty_token AS INTEGER) AS dirtyToken
    FROM app.judgment_job jj
    INNER JOIN app.project_mart_refresh_state pmrs ON pmrs.project_id = jj.project_id
    WHERE jj.id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  return row?.dirtyToken == null ? null : Number(row.dirtyToken)
}

const getWrapVisibilityToken = ({
  lastProjectRefreshAckSeq,
  projectDirtyToken,
}: {
  lastProjectRefreshAckSeq: number | null
  projectDirtyToken: number | null
}) => {
  return projectDirtyToken ?? lastProjectRefreshAckSeq
}

const hasWrapVisibility = ({
  lastProjectRefreshAckSeq,
  wrapVisibilityAckSeq,
}: {
  lastProjectRefreshAckSeq: number | null
  wrapVisibilityAckSeq: number | null
}) => {
  return wrapVisibilityAckSeq == null
    ? true
    : lastProjectRefreshAckSeq == null
      ? false
      : lastProjectRefreshAckSeq >= wrapVisibilityAckSeq
}

const topUpSqliteQueueForJob = async (params: AddToQueueJobParams): Promise<void> => {
  const {job, readyTargetPerJob, addToQueueMaxBatchSize, serverJobId} = params
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(job.id)) {
    await sqliteService.initializeJob(job.id)
  }

  try {
    await sqliteService.ensureOwnedLease(job.id, serverJobId)
  } catch (error) {
    if (error instanceof JudgmentJobLeaseError) {
      addToQueueLogger.log(
        `addToQueue:lease:${job.id}`,
        '[addToQueue] skipped SQLite job because this process does not own the job lease',
        {jobId: job.id},
      )
      return
    }

    throw error
  }

  const countOfReadyPrompts = await sqliteService.getReadyCount(job.id)
  const promptsToFetchCount = getPromptsToFetchCount(countOfReadyPrompts, readyTargetPerJob, addToQueueMaxBatchSize)

  if (promptsToFetchCount === 0) {
    return
  }

  const jobConfig = await getJobConfig(job.id)

  if (!jobConfig) {
    console.error('[addToQueue] Job config not found for jobId:', job.id)
    return
  }

  const scanState = await sqliteService.getScanState(job.id)

  if (hasSqliteExhaustedCooldown(scanState.exhaustedAt)) {
    return
  }

  const shouldForceRawFallback = !hasWrapVisibility(scanState)

  const baseCursor = scanState.exhaustedAt ? null : scanState.cursor
  const initializeScanState = scanState.exhaustedAt
    ? sqliteService.setScanState(job.id, {
        cursor: null,
        exhaustedAt: null,
        scanEpoch: scanState.scanEpoch + 1,
        wrapVisibilityAckSeq: shouldForceRawFallback ? scanState.wrapVisibilityAckSeq : null,
      })
    : Promise.resolve()

  await initializeScanState

  const scanWindow = async ({
    cursor,
    readyCount,
    windowsLeft,
  }: {
    cursor: Awaited<ReturnType<typeof sqliteService.getScanState>>['cursor']
    readyCount: number
    windowsLeft: number
  }): Promise<void> => {
    if (readyCount >= readyTargetPerJob || windowsLeft <= 0) {
      return
    }

    const readyDeficit = Math.max(0, readyTargetPerJob - readyCount)
    const requestedWindowSize = getSqliteWindowSize(readyDeficit, addToQueueMaxBatchSize)
    const promptData = await judgmentsJobsCronGetPrompts(
      job.projectId,
      job.id,
      requestedWindowSize,
      cursor,
      shouldForceRawFallback,
    )
    const filteredEntries = await filterAlreadyJudged(promptData.promptEntries, jobConfig, job.id)
    const {humanFirst, rest} =
      jobConfig.humanJudgmentMode === 'summary'
        ? partitionPromptQueueEntriesByHumanSummaryAnswered(
            filteredEntries,
            await getAnsweredHumanSummaryArticleIds(filteredEntries, job.projectId),
          )
        : partitionPromptQueueEntriesByHumanAnswered(
            filteredEntries,
            await getAnsweredHumanPromptPairKeys(filteredEntries, job.projectId),
          )
    const prioritizedEntries = [...humanFirst, ...rest]

    await getInsertedReadyCount({
      filteredEntries: prioritizedEntries,
      humanFirstEntries: humanFirst,
      jobId: job.id,
      readyDeficit,
      serverJobId,
      sqliteService,
    })

    const nextReadyCount = await sqliteService.getReadyCount(job.id)
    const nextScanState = promptData.nextCursor
      ? {
          cursor: promptData.nextCursor,
          exhaustedAt: null,
          wrapVisibilityAckSeq: shouldForceRawFallback ? scanState.wrapVisibilityAckSeq : null,
        }
      : {
          cursor: null,
          exhaustedAt: new Date(),
          wrapVisibilityAckSeq: getWrapVisibilityToken({
            lastProjectRefreshAckSeq: scanState.lastProjectRefreshAckSeq,
            projectDirtyToken: await getProjectDirtyToken(job.id),
          }),
        }

    await sqliteService.setScanState(job.id, nextScanState)

    return promptData.nextCursor
      ? scanWindow({cursor: promptData.nextCursor, readyCount: nextReadyCount, windowsLeft: windowsLeft - 1})
      : undefined
  }

  const getNewStartMs = Date.now()

  await scanWindow({cursor: baseCursor, readyCount: countOfReadyPrompts, windowsLeft: sqliteScanMaxWindowsPerTick})

  const getNewMs = Date.now() - getNewStartMs
  const finalReadyCount = await sqliteService.getReadyCount(job.id)

  addToQueueLogger.log(`addToQueue:job:${job.id}`, '[addToQueue] sqlite top-up check', {
    fetchedNeeded: promptsToFetchCount,
    jobId: job.id,
    ms: getNewMs,
    projectId: job.projectId,
    ready: countOfReadyPrompts,
    readyAfter: finalReadyCount,
    readyTargetPerJob,
  })
}

const getJobConfig = async (jobId: string): Promise<JobConfig | null> => {
  const [config] = await getAppDatabaseService().queryJson<JobConfig>(`
    SELECT
      COALESCE(p.human_judgment_mode, 'prompt') AS humanJudgmentMode,
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
  return topUpSqliteQueueForJob(params)
}

export const judgmentsJobsAddToQueue = async (serverJobId: string): Promise<void> => {
  const runningJobs = await judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.syncOwnedLeases(
    runningJobs.map((job) => {
      return job.id
    }),
  )
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

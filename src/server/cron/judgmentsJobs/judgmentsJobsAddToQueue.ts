import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../services/projectVisibleJudgmentRule.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {shouldUseJudgeWorkerOwnerHandoff} from './judgeWorkerCompletionJournal.ts'
import {
  getJudgmentJobSqliteErrorMessage,
  isTransientJudgmentJobSqliteLockError,
} from './judgmentJobSqliteTransientLock.ts'
import {
  getJudgeWorkerReadOnlyAppDatabaseService,
  getJudgmentJobSqliteService,
  getJudgmentsCapacity,
  inferenceRuntimeConfig,
  JudgmentJobLeaseError,
  judgmentsJobsCronGetPrompts,
  judgmentsJobsGetRunningJobs,
} from './judgmentsJobsAddToQueueDependencies.ts'
import {getNormalizedProviderKeyProvider, getProviderKey} from './providerKey.ts'

type Job = Awaited<ReturnType<typeof judgmentsJobsGetRunningJobs>>[number]

type JobConfig = {
  humanJudgmentMode: 'prompt' | 'summary'
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

const addToQueueLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const addToQueueWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const addToQueueComponent = 'judgmentsJobsAddToQueue'
const sqliteScanOverscanMultiplier = 1
const sqliteScanMaxWindowsPerTick = 1
const sqliteScanMaxWindowSize = 128
const sqliteScanExhaustedCooldownMs = 60_000
const sqliteActiveBacklogRefillLowWatermarkRatio = 1
const sqliteActiveBacklogRefillLowWatermarkMinimumTarget = 32

type AddToQueueBucket = {addToQueueMaxBatchSize: number; jobs: Job[]; label: string; readyTargetPerJob: number}

const getReadyTargetMultiplier = () => {
  const readyTargetMultiplier = Math.max(1, inferenceRuntimeConfig.judgmentsReadyTargetMultiplier)
  return readyTargetMultiplier
}

const getBucketReadyTargetPerJob = ({jobCount, maxInflight}: {jobCount: number; maxInflight: number}) => {
  const readyTargetTotal = Math.max(1, maxInflight) * getReadyTargetMultiplier()
  const normalizedJobCount = Math.max(1, jobCount)
  return Math.max(1, Math.ceil(readyTargetTotal / normalizedJobCount))
}

const getAddToQueueMaxBatchSize = ({isCodex}: {isCodex: boolean}) => {
  const envMaxBatch = Math.max(1, inferenceRuntimeConfig.judgmentsAddToQueueMaxBatchSize)
  return isCodex ? Math.min(envMaxBatch, 2000) : envMaxBatch
}

const getJobProvider = (job: Job): string | null => {
  const raw = (job as {modelProvider?: unknown}).modelProvider
  return typeof raw === 'string' ? raw : null
}

const isCodexJob = (job: Job): boolean => {
  return getNormalizedProviderKeyProvider(getJobProvider(job)) === 'codex'
}

const getJobProviderKey = (job: Job): string => {
  return getProviderKey({
    modelId: job.modelId,
    modelProvider: getJobProvider(job),
    providerConnectionId: job.providerConnectionId,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
}

const getAddToQueueBucketLabel = (job: Job, providerKey: string): string => {
  return providerKey.includes(':') ? providerKey : `${isCodexJob(job) ? 'codex' : 'provider'}:${providerKey}`
}

const getAddToQueueBucketMaxInflight = (jobs: Job[]): number => {
  const [firstJob] = jobs

  return !firstJob
    ? 1
    : firstJob.maxInflightRequests != null
      ? firstJob.maxInflightRequests
      : isCodexJob(firstJob)
        ? getCodexMaxInflight()
        : getJudgmentsCapacity(jobs.length).maxInflight
}

const getAddToQueueBuckets = (jobs: Job[]): AddToQueueBucket[] => {
  const grouped = jobs.reduce((state, job) => {
    const providerKey = getJobProviderKey(job)

    return new Map(state).set(providerKey, [...(state.get(providerKey) ?? []), job])
  }, new Map<string, Job[]>())

  return Array.from(grouped.entries()).flatMap(([providerKey, bucketJobs]) => {
    const [firstJob] = bucketJobs

    return firstJob
      ? [
          {
            addToQueueMaxBatchSize: getAddToQueueMaxBatchSize({isCodex: isCodexJob(firstJob)}),
            jobs: bucketJobs,
            label: getAddToQueueBucketLabel(firstJob, providerKey),
            readyTargetPerJob: getBucketReadyTargetPerJob({
              jobCount: bucketJobs.length,
              maxInflight: getAddToQueueBucketMaxInflight(bucketJobs),
            }),
          },
        ]
      : []
  })
}

const getPromptsToFetchCount = (
  readyCount: number,
  readyTargetPerJob: number,
  addToQueueMaxBatchSize: number,
): number => {
  const deficit = Math.max(0, readyTargetPerJob - readyCount)
  return Math.min(deficit, addToQueueMaxBatchSize)
}

const getActiveQueueBacklogCount = async ({
  jobId,
  readyCount,
  sqliteService,
}: {
  jobId: string
  readyCount: number
  sqliteService: ReturnType<typeof getJudgmentJobSqliteService>
}): Promise<number> => {
  const health = await (
    sqliteService as {
      getHealthSnapshot?: (
        jobId: string,
      ) => Promise<{promptCounts?: {claimed?: number; ready?: number; running?: number}}>
    }
  ).getHealthSnapshot?.(jobId)
  const counts = health?.promptCounts

  return counts
    ? Math.max(0, Number(counts.ready ?? 0) + Number(counts.claimed ?? 0) + Number(counts.running ?? 0))
    : readyCount
}

const getActiveBacklogRefillLowWatermark = (readyTargetPerJob: number): number => {
  const target = Math.max(1, readyTargetPerJob)

  return target < sqliteActiveBacklogRefillLowWatermarkMinimumTarget
    ? target
    : Math.max(1, Math.floor(target * sqliteActiveBacklogRefillLowWatermarkRatio))
}

const shouldRefillActiveQueueBacklog = ({
  activeQueueBacklogCount,
  readyTargetPerJob,
}: {
  activeQueueBacklogCount: number
  readyTargetPerJob: number
}): boolean => {
  return activeQueueBacklogCount < getActiveBacklogRefillLowWatermark(readyTargetPerJob)
}

type PromptQueueEntry = {articleId: string; promptId: string}

const sqliteBatchSize = 1000
const orphanedLocalQueueAutoRepairMaxRows = 1_000

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
      return getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{articleId: string; promptId: string}>(`
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
      return getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{articleId: string}>(`
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
  return promptEntries.reduce<{summaryHumanFirst: PromptQueueEntry[]; rest: PromptQueueEntry[]}>(
    (state, entry) => {
      const target = answeredHumanSummaryArticleIds.has(entry.articleId) ? state.summaryHumanFirst : state.rest

      target.push(entry)

      return state
    },
    {summaryHumanFirst: [], rest: []},
  )
}

const getPrioritizedPromptQueueEntries = async (
  filteredEntries: PromptQueueEntry[],
  {humanJudgmentMode, projectId}: {humanJudgmentMode: 'prompt' | 'summary' | null | undefined; projectId: string},
) => {
  const resolvedHumanJudgmentMode = humanJudgmentMode ?? 'prompt'

  if (resolvedHumanJudgmentMode === 'summary') {
    const {summaryHumanFirst, rest} = partitionPromptQueueEntriesByHumanSummaryAnswered(
      filteredEntries,
      await getAnsweredHumanSummaryArticleIds(filteredEntries, projectId),
    )

    return {humanFirstEntries: summaryHumanFirst, prioritizedEntries: [...summaryHumanFirst, ...rest]}
  }

  const {humanFirst, rest} = partitionPromptQueueEntriesByHumanAnswered(
    filteredEntries,
    await getAnsweredHumanPromptPairKeys(filteredEntries, projectId),
  )

  return {humanFirstEntries: humanFirst, prioritizedEntries: [...humanFirst, ...rest]}
}

/** Filter out prompt entries that already have judgments in the app database */
const filterAlreadyJudged = async (
  promptEntries: PromptQueueEntry[],
  jobId: string,
  projectId: string,
  readyDeficit: number,
  serverJobId: string,
): Promise<PromptQueueEntry[]> => {
  if (promptEntries.length === 0) return []

  const sqliteService = getJudgmentJobSqliteService()

  const filtered: PromptQueueEntry[] = []

  for (let i = 0; i < promptEntries.length; i += sqliteBatchSize) {
    const batch = promptEntries.slice(i, i + sqliteBatchSize)

    // Find which pairs already have judgments
    const existingJudgments = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{
      articleId: string
      promptId: string
    }>(`
      WITH pairs(article_id, prompt_id) AS (
        VALUES ${batch
          .map((entry) => {
            return `(${getSqlLiteral(entry.articleId)}, ${getSqlLiteral(entry.promptId)})`
          })
          .join(', ')}
      ),
      route_scope AS (
        SELECT
          pir.project_id,
          air.article_id
        FROM app.project_import_route pir
        INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
        INNER JOIN pairs p ON p.article_id = air.article_id
        WHERE pir.project_id = ${getSqlLiteral(projectId)}
      ),
      curated_scope AS (
        SELECT
          pa.project_id,
          pa.article_id
        FROM app.project_article pa
        INNER JOIN pairs p ON p.article_id = pa.article_id
        WHERE pa.project_id = ${getSqlLiteral(projectId)}
      ),
      project_scope_article AS (
        SELECT DISTINCT project_id, article_id FROM route_scope
        UNION
        SELECT DISTINCT project_id, article_id FROM curated_scope
      )
      SELECT DISTINCT j.article_id AS articleId, j.prompt_id AS promptId
      FROM pairs p
      INNER JOIN app.project project ON project.id = ${getSqlLiteral(projectId)}
      INNER JOIN project_scope_article scope_article
        ON scope_article.project_id = project.id
       AND scope_article.article_id = p.article_id
      INNER JOIN app.project_prompt project_prompt
        ON project_prompt.project_id = project.id
       AND project_prompt.prompt_id = p.prompt_id
      INNER JOIN app.judgment j
        ON j.article_id = p.article_id
       AND j.prompt_id = p.prompt_id
      WHERE ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'j',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'scope_article',
      })}
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
    addToQueueLogger.log(
      'judgmentQueue.addToQueue.filterAlreadyJudged',
      '[addToQueue] filtered already-judged entries',
      {component: addToQueueComponent, event: 'filterAlreadyJudged', jobId, projectId, skipped},
    )
  }

  const filteredForLocalJudgments = await sqliteService.filterOutLocallyJudgedPrompts(jobId, filtered)

  const locallySkipped = filtered.length - filteredForLocalJudgments.length
  if (locallySkipped > 0) {
    addToQueueLogger.log(
      'judgmentQueue.addToQueue.filterLocallyJudged',
      '[addToQueue] filtered locally-judged SQLite entries',
      {component: addToQueueComponent, event: 'filterLocallyJudged', jobId, locallySkipped, projectId},
    )
  }

  if (filtered.length > 0 && filteredForLocalJudgments.length === 0 && readyDeficit > 0) {
    const sqliteHealth = await sqliteService.getHealthSnapshot(jobId)

    if (sqliteHealth.orphanedJudgedRowCount > 0) {
      const autoRepairMaxRows = Math.min(readyDeficit, orphanedLocalQueueAutoRepairMaxRows)
      const repairResult = await sqliteService.repairOrphanedJudgedQueueRows({
        jobId,
        maxRows: autoRepairMaxRows,
        serverJobId,
      })

      addToQueueWarningLogger.warn(
        `judgmentQueue.addToQueue.orphanedLocalQueue.${jobId}`,
        '[addToQueue] auto-repaired orphaned judged rows blocking ready-fill candidates',
        {
          autoRepairMaxRows,
          component: addToQueueComponent,
          event: 'orphanedLocalQueue',
          jobId,
          locallySkipped,
          orphanedJudgedRowCount: sqliteHealth.orphanedJudgedRowCount,
          projectId,
          repairedDeletedRows: repairResult.deletedRows,
          repairedRequeuedRows: repairResult.requeuedRows,
        },
      )
    }
  }

  return filteredForLocalJudgments
}

const getSqliteWindowSize = (readyDeficit: number, addToQueueMaxBatchSize: number) => {
  return Math.min(
    sqliteScanMaxWindowSize,
    addToQueueMaxBatchSize * sqliteScanOverscanMultiplier,
    Math.max(readyDeficit, readyDeficit * sqliteScanOverscanMultiplier),
  )
}

const getInsertedReadyCount = async ({
  filteredEntries,
  humanFirstEntries,
  jobId,
  projectId,
  readyDeficit,
  serverJobId,
  sqliteService,
}: {
  filteredEntries: PromptQueueEntry[]
  humanFirstEntries: PromptQueueEntry[]
  jobId: string
  projectId: string
  readyDeficit: number
  serverJobId: string
  sqliteService: ReturnType<typeof getJudgmentJobSqliteService>
}) => {
  const insertableHumanFirstEntries =
    humanFirstEntries.length > 0 ? await sqliteService.filterOutExistingQueuedPrompts(jobId, humanFirstEntries) : []
  const insertedCount = await sqliteService.addReadyPrompts(jobId, filteredEntries, serverJobId, readyDeficit)

  if (humanFirstEntries.length > 0) {
    const insertedHumanFirstCount = Math.min(insertedCount, readyDeficit, insertableHumanFirstEntries.length)

    addToQueueLogger.log('judgmentQueue.addToQueue.prioritizedHumanEntries', '[addToQueue] prioritized human entries', {
      component: addToQueueComponent,
      event: 'prioritizedHumanEntries',
      humanFirstEntries: humanFirstEntries.length,
      insertedHumanFirstCount,
      jobId,
      projectId,
    })
  }

  return insertedCount
}

const hasSqliteExhaustedCooldown = (exhaustedAt: Date | null) => {
  return exhaustedAt ? Date.now() - exhaustedAt.getTime() < sqliteScanExhaustedCooldownMs : false
}

const getProjectDirtyToken = async (jobId: string): Promise<number | null> => {
  const [row] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{dirtyToken: number | null}>(`
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

const getMaxVisibilityToken = (tokens: Array<number | null>) => {
  return tokens.reduce<number | null>((maxToken, token) => {
    return token == null ? maxToken : maxToken == null ? token : Math.max(maxToken, token)
  }, null)
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
        `judgmentQueue.addToQueue.leaseSkipped.${job.id}`,
        '[addToQueue] skipped SQLite job because this process does not own the job lease',
        {component: addToQueueComponent, event: 'leaseSkipped', jobId: job.id, projectId: job.projectId},
      )
      return
    }

    throw error
  }

  const countOfReadyPrompts = await sqliteService.getReadyCount(job.id)
  const activeQueueBacklogCount = await getActiveQueueBacklogCount({
    jobId: job.id,
    readyCount: countOfReadyPrompts,
    sqliteService,
  })

  if (!shouldRefillActiveQueueBacklog({activeQueueBacklogCount, readyTargetPerJob})) {
    return
  }

  const promptsToFetchCount = getPromptsToFetchCount(activeQueueBacklogCount, readyTargetPerJob, addToQueueMaxBatchSize)

  if (promptsToFetchCount === 0) {
    return
  }

  const jobConfig = await getJobConfig(job.id)

  if (!jobConfig) {
    addToQueueWarningLogger.error(
      `judgmentQueue.addToQueue.missingJobConfig.${job.id}`,
      '[addToQueue] Job config not found for jobId',
      {component: addToQueueComponent, event: 'missingJobConfig', jobId: job.id, projectId: job.projectId},
    )
    return
  }

  const scanState = await sqliteService.getScanState(job.id)
  const exhaustedProjectDirtyToken = scanState.exhaustedAt ? await getProjectDirtyToken(job.id) : null
  const wrapVisibilityAckSeq = getMaxVisibilityToken([
    scanState.wrapVisibilityAckSeq,
    scanState.exhaustedAt
      ? getWrapVisibilityToken({
          lastProjectRefreshAckSeq: scanState.lastProjectRefreshAckSeq,
          projectDirtyToken: exhaustedProjectDirtyToken,
        })
      : null,
  ])
  const shouldForceRawFallback = !hasWrapVisibility({
    lastProjectRefreshAckSeq: scanState.lastProjectRefreshAckSeq,
    wrapVisibilityAckSeq,
  })

  if (hasSqliteExhaustedCooldown(scanState.exhaustedAt) && !shouldForceRawFallback) {
    return
  }

  const baseCursor = scanState.exhaustedAt ? null : scanState.cursor
  const initializeScanState = scanState.exhaustedAt
    ? sqliteService.setScanState(job.id, {
        cursor: null,
        exhaustedAt: null,
        scanEpoch: scanState.scanEpoch + 1,
        wrapVisibilityAckSeq: shouldForceRawFallback ? wrapVisibilityAckSeq : null,
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
    const filteredEntries = await filterAlreadyJudged(
      promptData.promptEntries,
      job.id,
      job.projectId,
      readyDeficit,
      serverJobId,
    )
    const {humanFirstEntries, prioritizedEntries} = await getPrioritizedPromptQueueEntries(filteredEntries, {
      humanJudgmentMode: jobConfig.humanJudgmentMode ?? 'prompt',
      projectId: job.projectId,
    })

    await getInsertedReadyCount({
      filteredEntries: prioritizedEntries,
      humanFirstEntries,
      jobId: job.id,
      projectId: job.projectId,
      readyDeficit,
      serverJobId,
      sqliteService,
    })

    const nextReadyCount = await getActiveQueueBacklogCount({
      jobId: job.id,
      readyCount: await sqliteService.getReadyCount(job.id),
      sqliteService,
    })
    const nextScanState = promptData.nextCursor
      ? {
          cursor: promptData.nextCursor,
          exhaustedAt: null,
          wrapVisibilityAckSeq: shouldForceRawFallback ? wrapVisibilityAckSeq : null,
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

  await scanWindow({cursor: baseCursor, readyCount: activeQueueBacklogCount, windowsLeft: sqliteScanMaxWindowsPerTick})

  const getNewMs = Date.now() - getNewStartMs
  const finalReadyCount = await sqliteService.getReadyCount(job.id)

  addToQueueLogger.log(`judgmentQueue.addToQueue.topUp.${job.id}`, '[addToQueue] sqlite top-up check', {
    component: addToQueueComponent,
    event: 'topUp',
    activeBacklog: activeQueueBacklogCount,
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
  const [config] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<JobConfig>(`
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
  try {
    return await topUpSqliteQueueForJob(params)
  } catch (error) {
    if (isTransientJudgmentJobSqliteLockError(error)) {
      addToQueueWarningLogger.warn(
        `judgmentQueue.addToQueue.transientSqliteLock.${params.job.id}`,
        '[addToQueue] skipped SQLite job after transient lock',
        {
          component: addToQueueComponent,
          errorMessage: getJudgmentJobSqliteErrorMessage(error),
          event: 'transientSqliteLock',
          jobId: params.job.id,
          projectId: params.job.projectId,
        },
      )
      return
    }

    throw error
  }
}

export const judgmentsJobsAddToQueue = async (serverJobId: string): Promise<void> => {
  const runningJobs = await judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.syncOwnedLeases(
    runningJobs.map((job) => {
      return job.id
    }),
  )
  const addToQueueBuckets = getAddToQueueBuckets(runningJobs)

  addToQueueLogger.log('judgmentQueue.addToQueue.tick', '[addToQueue] tick', {
    serverJobId,
    component: addToQueueComponent,
    event: 'tick',
    buckets: addToQueueBuckets.map((bucket) => {
      return {
        addToQueueMaxBatchSize: bucket.addToQueueMaxBatchSize,
        jobCount: bucket.jobs.length,
        label: bucket.label,
        readyTargetPerJob: bucket.readyTargetPerJob,
      }
    }),
    jobCount: runningJobs.length,
  })

  const addForJobs = async (jobs: Job[], readyTargetPerJob: number, addToQueueMaxBatchSize: number) => {
    await jobs.reduce(async (prev, job) => {
      await prev
      await addToQueueForJob({job, readyTargetPerJob, addToQueueMaxBatchSize, serverJobId})
    }, Promise.resolve())
  }

  await addToQueueBuckets.reduce(async (prev, bucket) => {
    await prev
    await addForJobs(bucket.jobs, bucket.readyTargetPerJob, bucket.addToQueueMaxBatchSize)
  }, Promise.resolve())
}

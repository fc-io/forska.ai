import {
  isJudgmentJobArticleCapReached,
  isJudgmentJobDeadlineReached,
  isJudgmentJobTokenBudgetReached,
  type JudgmentJobStopConditions,
  type JudgmentJobStopReason,
} from '../../../utils/judgmentJobStopConditions.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {
  getJudgmentJobJudgedArticleIds,
  getJudgmentJobTotalTokens,
  getPendingPairsForAdmittedArticles,
} from './judgmentJobAdmittedArticles.ts'
import {pauseJudgmentJobForStopCondition} from './judgmentJobStatusMutation.ts'
import {
  getJudgeWorkerReadOnlyAppDatabaseService,
  type getJudgmentJobSqliteService,
} from './judgmentsJobsAddToQueueDependencies.ts'

type SqliteService = ReturnType<typeof getJudgmentJobSqliteService>
type StopConditionJob = {id: string; projectId: string}
type PromptEntry = {articleId: string; promptId: string}
type QueueIdleState = Awaited<ReturnType<SqliteService['getQueueIdleState']>>

export type JudgmentJobArticleAdmission = {admittedCount: number; cap: number}

export type JudgmentJobStopRefillMode = 'finishAdmitted' | 'none' | 'normal'

export type JudgmentJobStopPlan = {
  articleAdmission: JudgmentJobArticleAdmission | null
  humanAnsweredOnly: boolean
  readyToPause: boolean
  refill: JudgmentJobStopRefillMode
  stopReason: JudgmentJobStopReason | null
}

export type ArticleCapSelection<T extends PromptEntry> = {
  deferredEntries: T[]
  entries: T[]
  newArticleIds: string[]
  skippedCount: number
}

type FinishAdmittedState = {
  afterArticleId: string | null
  completedIdlePass: boolean
  passActive: boolean
  passFoundPending: boolean
  passStartedIdle: boolean
}

type EntryAdmissionDecision = 'admit' | 'defer' | 'keep' | 'skip'

const stopConditionLogger = createRateLimitedLogger({sink: 'both', windowMs: 60_000})
const stopConditionComponent = 'judgmentJobStopConditions'
const totalTokensCacheTtlMs = 15_000
const finishAdmittedChunkSize = 128
const finishAdmittedMaxChunksPerTick = 4
const firstStopReasonByJobId = new Map<string, JudgmentJobStopReason>()
const humanAnsweredExhaustedByJobId = new Map<string, boolean>()
const finishAdmittedStateByJobId = new Map<string, FinishAdmittedState>()
const totalTokensCacheByJobId = new Map<string, {expiresAt: number; value: number}>()

const getStopConditionLogKey = (jobId: string) => {
  return `judgmentsJobs.stopCondition.${jobId}`
}

const deleteJobStopConditionState = (jobId: string) => {
  firstStopReasonByJobId.delete(jobId)
  humanAnsweredExhaustedByJobId.delete(jobId)
  finishAdmittedStateByJobId.delete(jobId)
  totalTokensCacheByJobId.delete(jobId)
}

export const resetJudgmentJobStopConditionStateForTests = (): void => {
  firstStopReasonByJobId.clear()
  humanAnsweredExhaustedByJobId.clear()
  finishAdmittedStateByJobId.clear()
  totalTokensCacheByJobId.clear()
}

export const pruneJudgmentJobStopConditionState = (runningJobIds: string[]): void => {
  const runningJobIdSet = new Set(runningJobIds)
  const trackedJobIds = new Set([
    ...firstStopReasonByJobId.keys(),
    ...humanAnsweredExhaustedByJobId.keys(),
    ...finishAdmittedStateByJobId.keys(),
    ...totalTokensCacheByJobId.keys(),
  ])

  Array.from(trackedJobIds)
    .filter((jobId) => {
      return !runningJobIdSet.has(jobId)
    })
    .map(deleteJobStopConditionState)
}

export const recordHumanAnsweredPassResult = (jobId: string, exhausted: boolean): void => {
  humanAnsweredExhaustedByJobId.set(jobId, exhausted)
}

export const getSatisfiedStopReasons = ({
  admittedArticleCount,
  conditions,
  humanAnsweredDone,
  now,
  totalTokens,
}: {
  admittedArticleCount: number | null
  conditions: JudgmentJobStopConditions
  humanAnsweredDone: boolean
  now: Date
  totalTokens: number | null
}): JudgmentJobStopReason[] => {
  const reasons: Array<[JudgmentJobStopReason, boolean]> = [
    ['deadline', isJudgmentJobDeadlineReached(conditions.stopAt, now)],
    ['token_budget', isJudgmentJobTokenBudgetReached(conditions.stopAfterTotalTokens, totalTokens)],
    ['article_cap', isJudgmentJobArticleCapReached(conditions.stopAfterArticles, admittedArticleCount)],
    ['human_answered_done', conditions.stopWhenHumanAnsweredDone && humanAnsweredDone],
  ]

  return reasons.flatMap(([reason, isSatisfied]) => {
    return isSatisfied ? [reason] : []
  })
}

export const pickFirstSatisfiedStopReason = (
  previousReason: JudgmentJobStopReason | null,
  satisfiedReasons: JudgmentJobStopReason[],
): JudgmentJobStopReason | null => {
  return previousReason !== null && satisfiedReasons.includes(previousReason)
    ? previousReason
    : (satisfiedReasons[0] ?? null)
}

const getEntryAdmissionDecision = ({
  hasCapacity,
  isAdmitted,
  isFull,
}: {
  hasCapacity: boolean
  isAdmitted: boolean
  isFull: boolean
}): EntryAdmissionDecision => {
  const admissionDecision = hasCapacity ? 'admit' : 'skip'
  const knownArticleDecision = isAdmitted ? 'keep' : admissionDecision

  return isFull ? 'defer' : knownArticleDecision
}

export const selectEntriesWithinArticleCap = <T extends PromptEntry>({
  admittedArticleIds,
  admittedCount,
  cap,
  entries,
  maxEntries,
}: {
  admittedArticleIds: ReadonlySet<string>
  admittedCount: number
  cap: number
  entries: T[]
  maxEntries: number
}): ArticleCapSelection<T> => {
  const initialSelection: ArticleCapSelection<T> = {
    deferredEntries: [],
    entries: [],
    newArticleIds: [],
    skippedCount: 0,
  }

  return entries.reduce((selection, entry) => {
    const decision = getEntryAdmissionDecision({
      hasCapacity: admittedCount + selection.newArticleIds.length < cap,
      isAdmitted: admittedArticleIds.has(entry.articleId) || selection.newArticleIds.includes(entry.articleId),
      isFull: selection.entries.length >= maxEntries,
    })
    const decisions: Record<EntryAdmissionDecision, () => ArticleCapSelection<T>> = {
      admit: () => {
        return {
          ...selection,
          entries: [...selection.entries, entry],
          newArticleIds: [...selection.newArticleIds, entry.articleId],
        }
      },
      defer: () => {
        return {...selection, deferredEntries: [...selection.deferredEntries, entry]}
      },
      keep: () => {
        return {...selection, entries: [...selection.entries, entry]}
      },
      skip: () => {
        return {...selection, skippedCount: selection.skippedCount + 1}
      },
    }

    return decisions[decision]()
  }, initialSelection)
}

export const selectEntriesForArticleAdmission = async <T extends PromptEntry>({
  admission,
  entries,
  jobId,
  maxEntries,
  sqliteService,
}: {
  admission: JudgmentJobArticleAdmission
  entries: T[]
  jobId: string
  maxEntries: number
  sqliteService: SqliteService
}): Promise<ArticleCapSelection<T>> => {
  const admittedArticleIds = new Set(
    await sqliteService.getAdmittedArticleIdsAmong(
      jobId,
      entries.map((entry) => {
        return entry.articleId
      }),
    ),
  )
  const selection = selectEntriesWithinArticleCap({
    admittedArticleIds,
    admittedCount: admission.admittedCount,
    cap: admission.cap,
    entries,
    maxEntries,
  })

  admission.admittedCount += selection.newArticleIds.length

  return selection
}

const isQueueIdle = (state: QueueIdleState) => {
  return state.activeRowCount === 0 && state.unexportedOutboxCount === 0 && state.pendingTokenUseCount === 0
}

const getCachedTotalTokens = async (jobId: string): Promise<number> => {
  const cached = totalTokensCacheByJobId.get(jobId)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const value = await getJudgmentJobTotalTokens({db: getJudgeWorkerReadOnlyAppDatabaseService(), jobId})

  totalTokensCacheByJobId.set(jobId, {expiresAt: Date.now() + totalTokensCacheTtlMs, value})

  return value
}

const backfillAdmittedArticles = async ({
  job,
  serverJobId,
  sqliteService,
}: {
  job: StopConditionJob
  serverJobId: string
  sqliteService: SqliteService
}): Promise<number> => {
  const queuedArticleCount = await sqliteService.admitQueuedArticles(job.id, serverJobId)
  const judgedArticleIds = await getJudgmentJobJudgedArticleIds({
    db: getJudgeWorkerReadOnlyAppDatabaseService(),
    jobId: job.id,
  })
  const admittedCount = await sqliteService.completeAdmittedArticleBackfill(job.id, judgedArticleIds, serverJobId)

  stopConditionLogger.force(
    `${getStopConditionLogKey(job.id)}.backfill`,
    '[judgmentsJobs] backfilled admitted articles for the article stop condition',
    'log',
    {
      admittedCount,
      component: stopConditionComponent,
      event: 'admittedArticleBackfill',
      jobId: job.id,
      judgedArticleCount: judgedArticleIds.length,
      projectId: job.projectId,
      queuedArticleCount,
    },
  )

  return admittedCount
}

const getAdmittedArticleCount = async ({
  job,
  serverJobId,
  sqliteService,
}: {
  job: StopConditionJob
  serverJobId: string
  sqliteService: SqliteService
}): Promise<number> => {
  const state = await sqliteService.getAdmittedArticleState(job.id)

  return state.backfilled ? state.count : backfillAdmittedArticles({job, serverJobId, sqliteService})
}

const getRefillMode = (satisfiedReasons: JudgmentJobStopReason[]): JudgmentJobStopRefillMode => {
  const isHardStop = satisfiedReasons.includes('deadline') || satisfiedReasons.includes('token_budget')

  return isHardStop ? 'none' : satisfiedReasons.includes('article_cap') ? 'finishAdmitted' : 'normal'
}

const getIsReadyToPause = ({
  jobId,
  refill,
  satisfiedReasons,
}: {
  jobId: string
  refill: JudgmentJobStopRefillMode
  satisfiedReasons: JudgmentJobStopReason[]
}) => {
  const isRefillFinished =
    refill === 'finishAdmitted'
      ? finishAdmittedStateByJobId.get(jobId)?.completedIdlePass === true
      : satisfiedReasons.includes('human_answered_done')

  return refill === 'none' || isRefillFinished
}

export const getJudgmentJobStopPlan = async ({
  conditions,
  job,
  now = new Date(),
  serverJobId,
  sqliteService,
}: {
  conditions: JudgmentJobStopConditions
  job: StopConditionJob
  now?: Date
  serverJobId: string
  sqliteService: SqliteService
}): Promise<JudgmentJobStopPlan> => {
  const totalTokens = conditions.stopAfterTotalTokens === null ? null : await getCachedTotalTokens(job.id)
  const admittedArticleCount =
    conditions.stopAfterArticles === null ? null : await getAdmittedArticleCount({job, serverJobId, sqliteService})
  const satisfiedReasons = getSatisfiedStopReasons({
    admittedArticleCount,
    conditions,
    humanAnsweredDone: humanAnsweredExhaustedByJobId.get(job.id) === true,
    now,
    totalTokens,
  })
  const stopReason = pickFirstSatisfiedStopReason(firstStopReasonByJobId.get(job.id) ?? null, satisfiedReasons)
  const refill = getRefillMode(satisfiedReasons)

  if (stopReason === null) {
    firstStopReasonByJobId.delete(job.id)
  } else {
    firstStopReasonByJobId.set(job.id, stopReason)
    stopConditionLogger.log(
      getStopConditionLogKey(job.id),
      '[judgmentsJobs] stop condition satisfied; the job pauses once its queued work finishes',
      {
        admittedArticleCount,
        component: stopConditionComponent,
        event: 'stopConditionSatisfied',
        jobId: job.id,
        projectId: job.projectId,
        refill,
        satisfiedReasons,
        stopAfterArticles: conditions.stopAfterArticles,
        stopAfterTotalTokens: conditions.stopAfterTotalTokens,
        stopAt: conditions.stopAt?.toISOString() ?? null,
        stopReason,
        totalTokens,
      },
    )
  }

  if (refill !== 'finishAdmitted') {
    finishAdmittedStateByJobId.delete(job.id)
  }

  return {
    articleAdmission:
      conditions.stopAfterArticles !== null && admittedArticleCount !== null && refill === 'normal'
        ? {admittedCount: admittedArticleCount, cap: conditions.stopAfterArticles}
        : null,
    humanAnsweredOnly: conditions.stopWhenHumanAnsweredDone,
    readyToPause: getIsReadyToPause({jobId: job.id, refill, satisfiedReasons}),
    refill,
    stopReason,
  }
}

const getFinishAdmittedState = (jobId: string): FinishAdmittedState => {
  const existingState = finishAdmittedStateByJobId.get(jobId)

  if (existingState) {
    return existingState
  }

  const nextState = {
    afterArticleId: null,
    completedIdlePass: false,
    passActive: false,
    passFoundPending: false,
    passStartedIdle: false,
  }
  finishAdmittedStateByJobId.set(jobId, nextState)

  return nextState
}

const startFinishAdmittedPass = async ({
  jobId,
  sqliteService,
  state,
}: {
  jobId: string
  sqliteService: SqliteService
  state: FinishAdmittedState
}) => {
  const idleState = await sqliteService.getQueueIdleState(jobId)

  state.afterArticleId = null
  state.completedIdlePass = false
  state.passActive = true
  state.passFoundPending = false
  state.passStartedIdle = idleState.activeRowCount === 0
}

const completeFinishAdmittedPass = (state: FinishAdmittedState) => {
  state.afterArticleId = null
  state.completedIdlePass = state.passStartedIdle && !state.passFoundPending
  state.passActive = false
}

const sweepAdmittedArticleChunk = async (input: {
  chunksLeft: number
  insertedCount: number
  job: StopConditionJob
  readyDeficit: number
  serverJobId: string
  sqliteService: SqliteService
  state: FinishAdmittedState
}): Promise<number> => {
  const {job, serverJobId, sqliteService, state} = input
  const remainingDeficit = input.readyDeficit - input.insertedCount

  if (remainingDeficit <= 0 || input.chunksLeft <= 0) {
    return input.insertedCount
  }

  const articleIds = await sqliteService.getAdmittedArticleIdsAfter(
    job.id,
    state.afterArticleId,
    finishAdmittedChunkSize,
  )

  if (articleIds.length === 0) {
    completeFinishAdmittedPass(state)
    return input.insertedCount
  }

  const pendingPairs = await getPendingPairsForAdmittedArticles({
    articleIds,
    db: getJudgeWorkerReadOnlyAppDatabaseService(),
    jobId: job.id,
  })
  const insertablePairs = await sqliteService.filterOutExistingQueuedPrompts(job.id, pendingPairs)
  const pairsToInsert = insertablePairs.slice(0, remainingDeficit)
  const addedCount =
    pairsToInsert.length === 0
      ? 0
      : await sqliteService.addReadyPrompts(job.id, pairsToInsert, serverJobId, remainingDeficit)

  state.passFoundPending = state.passFoundPending || insertablePairs.length > 0
  state.afterArticleId =
    insertablePairs.length > remainingDeficit ? state.afterArticleId : (articleIds.at(-1) ?? state.afterArticleId)

  return insertablePairs.length > remainingDeficit
    ? input.insertedCount + addedCount
    : sweepAdmittedArticleChunk({
        ...input,
        chunksLeft: input.chunksLeft - 1,
        insertedCount: input.insertedCount + addedCount,
      })
}

export const finishAdmittedArticlesForJob = async ({
  job,
  readyDeficit,
  serverJobId,
  sqliteService,
}: {
  job: StopConditionJob
  readyDeficit: number
  serverJobId: string
  sqliteService: SqliteService
}): Promise<number> => {
  const state = getFinishAdmittedState(job.id)

  if (readyDeficit <= 0) {
    return 0
  }

  if (!state.passActive) {
    await startFinishAdmittedPass({jobId: job.id, sqliteService, state})
  }

  const insertedCount = await sweepAdmittedArticleChunk({
    chunksLeft: finishAdmittedMaxChunksPerTick,
    insertedCount: 0,
    job,
    readyDeficit,
    serverJobId,
    sqliteService,
    state,
  })

  stopConditionLogger.log(
    `${getStopConditionLogKey(job.id)}.finishAdmitted`,
    '[judgmentsJobs] article stop condition reached; queueing remaining pairs of admitted articles',
    {
      completedIdlePass: state.completedIdlePass,
      component: stopConditionComponent,
      event: 'finishAdmittedArticles',
      insertedCount,
      jobId: job.id,
      projectId: job.projectId,
    },
  )

  return insertedCount
}

export const pauseJudgmentJobWhenStopped = async ({
  job,
  plan,
  sqliteService,
}: {
  job: StopConditionJob
  plan: JudgmentJobStopPlan
  sqliteService: SqliteService
}): Promise<boolean> => {
  const idleState = plan.readyToPause && plan.stopReason !== null ? await sqliteService.getQueueIdleState(job.id) : null

  if (idleState === null || plan.stopReason === null || !isQueueIdle(idleState)) {
    return false
  }

  const paused = await pauseJudgmentJobForStopCondition({jobId: job.id, stopReason: plan.stopReason})

  if (paused) {
    deleteJobStopConditionState(job.id)
    stopConditionLogger.force(getStopConditionLogKey(job.id), '[judgmentsJobs] paused by stop condition', 'log', {
      component: stopConditionComponent,
      event: 'stopConditionPaused',
      jobId: job.id,
      projectId: job.projectId,
      stopReason: plan.stopReason,
    })
  }

  return paused
}

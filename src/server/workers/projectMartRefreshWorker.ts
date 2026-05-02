import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
import {getProjectMartLargeRebuildStateService} from '../services/projectMartLargeRebuildStateService.ts'
import {
  getProjectMartRefreshStateService,
  type ProjectRefreshClaim,
} from '../services/projectMartRefreshStateService.ts'

type ProjectMartRefreshStateWorkerService = {
  claimDirtyProjects: (params: {
    leaseMs: number
    limit: number
    now?: Date
    workerId: string
  }) => Promise<ProjectRefreshClaim[]>
  clearArchivedProjectRefreshStates: (params?: {now?: Date}) => Promise<unknown>
  completeDirtyArticleBatchForClaim: (params: {
    articleIds: string[]
    claimedToken: number
    now?: Date
    projectId: string
    workerId: string
  }) => Promise<{completedState: unknown; isClaimComplete: boolean}>
  completeProjectRefresh: (params: {
    completedToken: number
    now?: Date
    projectId: string
    workerId: string
  }) => Promise<unknown>
  failProjectRefresh: (params: {error: string; now?: Date; projectId: string; workerId: string}) => Promise<unknown>
  getDirtyArticleBatchForClaim: (params: {
    batchSize: number
    claimedToken: number
    projectId: string
    workerId: string
  }) => Promise<{articleIds: string[]; hasMore: boolean}>
  heartbeatClaim: (params: {
    leaseMs: number
    now?: Date
    projectId: string
    workerId: string
  }) => Promise<ProjectRefreshClaim | null>
  releaseProjectRefreshClaim: (params: {now?: Date; projectId: string; workerId: string}) => Promise<unknown>
}

type ProjectMartLargeRebuildStateWorkerService = {
  clearArchivedLargeRebuildStates: () => Promise<unknown>
  queueLargeRebuild: (params: {
    cursorArticleCreatedAt?: Date | null
    cursorArticleId?: string | null
    now?: Date
    projectId: string
    rebuildPhase:
      | 'judgment_fact'
      | 'prompt_answer_fact'
      | 'review_answer_dictionary'
      | 'review_article_filter_member'
      | 'review_article_rollup'
      | 'review_article_serving'
    refreshToken: number
    targetGeneration?: number | null
  }) => Promise<unknown>
}

type ProjectMartRefreshRunnerService = {
  hasActiveProjectReviewServingGeneration: (projectId: string) => Promise<boolean>
  refreshJudgmentArticle: (articleId: string) => Promise<void>
  refreshJudgmentFactsForArticles: (articleIds: string[]) => Promise<void>
  refreshProjectScopeArticles: (projectId: string, articleIds: string[]) => Promise<void>
  refreshProjectArticleMartsBatch: (projectId: string, articleIds: string[]) => Promise<void>
}

type ProjectMartRefreshWorkerDependencies = {
  largeRebuildStateService: ProjectMartLargeRebuildStateWorkerService
  projectInspector: {getProjectScopeArticleCount: (projectId: string) => Promise<number>}
  refreshService: ProjectMartRefreshRunnerService
  sleep: typeof sleep
  sqliteService: {
    publishProjectRefreshAck: (params: {ackToken: number | null; projectId: string}) => Promise<number>
    reconcileProjectRefreshAcks: (params?: {projectId?: string}) => Promise<number>
  }
  stateService: ProjectMartRefreshStateWorkerService
}

type ProjectMartRefreshWorkerCycleOptions = {
  dirtyArticleBatchSize?: number
  heartbeatMs?: number
  leaseMs?: number
  now?: Date
  workerId?: string
}

type ProjectMartRefreshWorkerLoopOptions = ProjectMartRefreshWorkerCycleOptions & {
  pollIntervalMs?: number
  signal?: AbortSignal
}

type ProjectMartRefreshWorkerCycleResult =
  | {projectId: null; status: 'idle'; workerId: string}
  | {claimedToken: number; projectId: string; status: 'completed'; workerId: string}
  | {claimedToken: number; error: string; projectId: string; status: 'failed'; workerId: string}

const defaultProjectMartRefreshWorkerLeaseMs = 30_000
const defaultProjectMartRefreshWorkerHeartbeatMs = 10_000
const defaultProjectMartRefreshWorkerDirtyArticleBatchSize = 3
const defaultProjectMartRefreshWorkerPollIntervalMs = 2_000

const getProjectScopeArticleCount = async (projectId: string) => {
  const [row] = await getAppDatabaseService().queryJson<{count: number | string}>(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT article_id
      FROM app.project_article
      WHERE project_id = '${projectId}'
      UNION
      SELECT air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air ON air.import_route_id = pir.import_route_id
      WHERE pir.project_id = '${projectId}'
    ) scope
  `)

  return Number(row?.count ?? 0)
}

const defaultProjectMartRefreshWorkerDependencies: ProjectMartRefreshWorkerDependencies = {
  largeRebuildStateService: getProjectMartLargeRebuildStateService(),
  projectInspector: {getProjectScopeArticleCount},
  refreshService: getDuckdbMartRefreshService(),
  sleep,
  sqliteService: getJudgmentJobSqliteService(),
  stateService: getProjectMartRefreshStateService(),
}

const getProjectMartRefreshWorkerId = () => {
  return `project-mart-refresh-worker:${hostname()}:${process.pid}`
}

const getWorkerNow = (now?: Date) => {
  return now ?? new Date()
}

const getClaimedProject = async (
  dependencies: ProjectMartRefreshWorkerDependencies,
  options: ProjectMartRefreshWorkerCycleOptions,
) => {
  const [claim] = await dependencies.stateService.claimDirtyProjects({
    leaseMs: options.leaseMs ?? defaultProjectMartRefreshWorkerLeaseMs,
    limit: 1,
    now: options.now,
    workerId: options.workerId ?? getProjectMartRefreshWorkerId(),
  })

  return claim ?? null
}

const getDirtyArticleBatchSize = (options: ProjectMartRefreshWorkerCycleOptions) => {
  const configuredBatchSize = options.dirtyArticleBatchSize ?? defaultProjectMartRefreshWorkerDirtyArticleBatchSize

  return Math.max(1, Math.floor(configuredBatchSize))
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const startClaimHeartbeat = (
  claim: ProjectRefreshClaim,
  dependencies: ProjectMartRefreshWorkerDependencies,
  options: ProjectMartRefreshWorkerCycleOptions,
) => {
  const interval = setInterval(() => {
    return void dependencies.stateService.heartbeatClaim({
      leaseMs: options.leaseMs ?? defaultProjectMartRefreshWorkerLeaseMs,
      now: getWorkerNow(),
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
  }, options.heartbeatMs ?? defaultProjectMartRefreshWorkerHeartbeatMs)

  interval.unref()

  return () => {
    clearInterval(interval)
  }
}

const queueBoundedInitialProjectMartSetup = async ({
  claim,
  dependencies,
  options,
  workerId,
}: {
  claim: ProjectRefreshClaim
  dependencies: ProjectMartRefreshWorkerDependencies
  options: ProjectMartRefreshWorkerCycleOptions
  workerId: string
}) => {
  await dependencies.projectInspector.getProjectScopeArticleCount(claim.projectId)
  await dependencies.largeRebuildStateService.queueLargeRebuild({
    now: getWorkerNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'judgment_fact',
    refreshToken: claim.claimedToken,
  })
  await dependencies.stateService.releaseProjectRefreshClaim({
    now: getWorkerNow(options.now),
    projectId: claim.projectId,
    workerId,
  })
}

const processDirtyArticleBatchForClaim = async ({
  claim,
  dependencies,
  options,
  workerId,
}: {
  claim: ProjectRefreshClaim
  dependencies: ProjectMartRefreshWorkerDependencies
  options: ProjectMartRefreshWorkerCycleOptions
  workerId: string
}): Promise<boolean> => {
  const dirtyArticleBatch = await dependencies.stateService.getDirtyArticleBatchForClaim({
    batchSize: getDirtyArticleBatchSize(options),
    claimedToken: claim.claimedToken,
    projectId: claim.projectId,
    workerId,
  })
  const dirtyArticleIds = dirtyArticleBatch.articleIds

  if (dirtyArticleIds.length > 0) {
    await dependencies.refreshService.refreshProjectScopeArticles(claim.projectId, dirtyArticleIds)
    await dependencies.refreshService.refreshJudgmentFactsForArticles(dirtyArticleIds)
    await dependencies.refreshService.refreshProjectArticleMartsBatch(claim.projectId, dirtyArticleIds)
  }

  const completion = await dependencies.stateService.completeDirtyArticleBatchForClaim({
    articleIds: dirtyArticleIds,
    claimedToken: claim.claimedToken,
    now: getWorkerNow(options.now),
    projectId: claim.projectId,
    workerId,
  })

  if (completion.isClaimComplete) {
    return true
  }

  if (dirtyArticleIds.length === 0) {
    throw new Error(`Project mart refresh claim made no progress for ${claim.projectId}`)
  }

  return processDirtyArticleBatchForClaim({claim, dependencies, options, workerId})
}

export const runProjectMartRefreshWorkerCycle = async (
  options: ProjectMartRefreshWorkerCycleOptions = {},
  dependencies: ProjectMartRefreshWorkerDependencies = defaultProjectMartRefreshWorkerDependencies,
): Promise<ProjectMartRefreshWorkerCycleResult> => {
  const workerId = options.workerId ?? getProjectMartRefreshWorkerId()

  await dependencies.sqliteService.reconcileProjectRefreshAcks()

  const claim = await getClaimedProject(dependencies, {...options, workerId})

  if (claim === null) {
    return {projectId: null, status: 'idle', workerId}
  }

  const stopHeartbeat = startClaimHeartbeat(claim, dependencies, {...options, workerId})
  let refreshCompleted = false

  try {
    if (!(await dependencies.refreshService.hasActiveProjectReviewServingGeneration(claim.projectId))) {
      await queueBoundedInitialProjectMartSetup({claim, dependencies, options, workerId})

      return {claimedToken: claim.claimedToken, projectId: claim.projectId, status: 'completed', workerId}
    }

    await processDirtyArticleBatchForClaim({claim, dependencies, options, workerId})
    refreshCompleted = true
    await dependencies.sqliteService.publishProjectRefreshAck({
      ackToken: claim.claimedToken,
      projectId: claim.projectId,
    })

    return {claimedToken: claim.claimedToken, projectId: claim.projectId, status: 'completed', workerId}
  } catch (error) {
    if (refreshCompleted) {
      throw error
    }

    const errorText = getErrorText(error)

    await dependencies.stateService.failProjectRefresh({
      error: errorText,
      now: getWorkerNow(options.now),
      projectId: claim.projectId,
      workerId,
    })

    return {claimedToken: claim.claimedToken, error: errorText, projectId: claim.projectId, status: 'failed', workerId}
  } finally {
    stopHeartbeat()
  }
}

export const runProjectMartRefreshWorkerOnce = async (
  options: ProjectMartRefreshWorkerCycleOptions = {},
  dependencies: ProjectMartRefreshWorkerDependencies = defaultProjectMartRefreshWorkerDependencies,
): Promise<ProjectMartRefreshWorkerCycleResult> => {
  return runProjectMartRefreshWorkerCycle(options, dependencies)
}

export const runProjectMartRefreshWorker = async (
  options: ProjectMartRefreshWorkerLoopOptions = {},
  dependencies: ProjectMartRefreshWorkerDependencies = defaultProjectMartRefreshWorkerDependencies,
): Promise<void> => {
  const cycleResult = await runProjectMartRefreshWorkerOnce(options, dependencies)

  if (options.signal?.aborted) {
    return
  }

  return cycleResult.status === 'idle'
    ? dependencies.sleep(options.pollIntervalMs ?? defaultProjectMartRefreshWorkerPollIntervalMs).then(() => {
        return runProjectMartRefreshWorker(options, dependencies)
      })
    : runProjectMartRefreshWorker(options, dependencies)
}

export {
  defaultProjectMartRefreshWorkerDirtyArticleBatchSize,
  defaultProjectMartRefreshWorkerHeartbeatMs,
  defaultProjectMartRefreshWorkerLeaseMs,
  defaultProjectMartRefreshWorkerPollIntervalMs,
  getProjectMartRefreshWorkerId,
}

export type {
  ProjectMartRefreshRunnerService,
  ProjectMartRefreshStateWorkerService,
  ProjectMartRefreshWorkerCycleOptions,
  ProjectMartRefreshWorkerCycleResult,
  ProjectMartRefreshWorkerDependencies,
  ProjectMartRefreshWorkerLoopOptions,
}

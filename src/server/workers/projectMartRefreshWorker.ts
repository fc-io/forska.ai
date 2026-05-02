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
import {parseDuckdbMemoryLimitToMiB} from '../utils/duckdbMemoryLimit.ts'

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
  refreshJudgmentArticle: (articleId: string) => Promise<void>
  refreshJudgmentFactsForProjectClaim: (params: {
    claimedToken: number
    lastCompletedToken: number
    projectId: string
  }) => Promise<void>
  refreshProject: (projectId: string) => Promise<void>
  refreshProjectScopeArticles: (projectId: string, articleIds: string[]) => Promise<void>
  refreshProjectArticleServing: (projectId: string, articleId: string) => Promise<void>
  refreshProjectArticleServingForArticles: (projectId: string, articleIds: string[]) => Promise<void>
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
  heartbeatMs?: number
  incrementalArticleThreshold?: number
  leaseMs?: number
  maxFullProjectScopeArticles?: number
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
const defaultProjectMartRefreshWorkerIncrementalArticleThreshold = 3
const defaultProjectMartRefreshWorkerMaxFullProjectScopeArticles = 100_000
const defaultProjectMartRefreshWorkerPollIntervalMs = 2_000
const lowMemoryProjectMartRefreshWorkerMaxFullProjectScopeArticles = 10_000
const mediumMemoryProjectMartRefreshWorkerMaxFullProjectScopeArticles = 20_000
const lowMemoryProjectMartRefreshWorkerDuckdbLimitMiB = 6400
const mediumMemoryProjectMartRefreshWorkerDuckdbLimitMiB = 8192

const getAutomaticProjectMartRefreshWorkerMaxFullProjectScopeArticles = (workerDuckdbMemoryLimitMiB: number | null) => {
  if (workerDuckdbMemoryLimitMiB === null) {
    return defaultProjectMartRefreshWorkerMaxFullProjectScopeArticles
  }

  if (workerDuckdbMemoryLimitMiB <= lowMemoryProjectMartRefreshWorkerDuckdbLimitMiB) {
    return lowMemoryProjectMartRefreshWorkerMaxFullProjectScopeArticles
  }

  return workerDuckdbMemoryLimitMiB <= mediumMemoryProjectMartRefreshWorkerDuckdbLimitMiB
    ? mediumMemoryProjectMartRefreshWorkerMaxFullProjectScopeArticles
    : defaultProjectMartRefreshWorkerMaxFullProjectScopeArticles
}

const getProjectMartRefreshWorkerMaxFullProjectScopeArticles = () => {
  const parsed = Number(process.env.PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES ?? '')

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : getAutomaticProjectMartRefreshWorkerMaxFullProjectScopeArticles(
        parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT),
      )
}

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

const getProjectMartRefreshExecutionMode = ({
  dirtyArticleCount,
  incrementalArticleThreshold,
}: {
  dirtyArticleCount: number
  incrementalArticleThreshold: number
}) => {
  return dirtyArticleCount === 0 ? 'idle' : dirtyArticleCount <= incrementalArticleThreshold ? 'incremental' : 'full'
}

const getDirtyArticleRoutingBatchSize = (incrementalArticleThreshold: number) => {
  return Math.max(1, incrementalArticleThreshold + 1)
}

const getFullRefreshBlockedErrorText = ({
  dirtyArticleCount,
  maxFullProjectScopeArticles,
  projectId,
  scopeArticleCount,
}: {
  dirtyArticleCount: number
  maxFullProjectScopeArticles: number
  projectId: string
  scopeArticleCount: number
}) => {
  return `Blocked automatic full refresh for project ${projectId}: scope_article_count=${scopeArticleCount}, dirty_article_count=${dirtyArticleCount}, max_full_project_scope_articles=${maxFullProjectScopeArticles}. Use guarded/manual recovery after reducing scope or raising PROJECT_MART_REFRESH_MAX_FULL_SCOPE_ARTICLES deliberately.`
}

const _assertFullRefreshIsSafe = async ({
  dependencies,
  dirtyArticleCount,
  maxFullProjectScopeArticles,
  projectId,
}: {
  dependencies: ProjectMartRefreshWorkerDependencies
  dirtyArticleCount: number
  maxFullProjectScopeArticles: number
  projectId: string
}) => {
  const scopeArticleCount = await dependencies.projectInspector.getProjectScopeArticleCount(projectId)

  if (scopeArticleCount > maxFullProjectScopeArticles) {
    throw new Error(
      getFullRefreshBlockedErrorText({dirtyArticleCount, maxFullProjectScopeArticles, projectId, scopeArticleCount}),
    )
  }
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
    const incrementalArticleThreshold =
      options.incrementalArticleThreshold ?? defaultProjectMartRefreshWorkerIncrementalArticleThreshold
    const dirtyArticleBatch = await dependencies.stateService.getDirtyArticleBatchForClaim({
      batchSize: getDirtyArticleRoutingBatchSize(incrementalArticleThreshold),
      claimedToken: claim.claimedToken,
      projectId: claim.projectId,
      workerId,
    })
    const dirtyArticleIds = dirtyArticleBatch.articleIds
    const maxFullProjectScopeArticles =
      options.maxFullProjectScopeArticles ?? getProjectMartRefreshWorkerMaxFullProjectScopeArticles()
    const executionMode = getProjectMartRefreshExecutionMode({
      dirtyArticleCount: dirtyArticleIds.length,
      incrementalArticleThreshold,
    })
    const scopeArticleCount =
      executionMode === 'full' ? await dependencies.projectInspector.getProjectScopeArticleCount(claim.projectId) : null

    if (scopeArticleCount !== null && scopeArticleCount > maxFullProjectScopeArticles) {
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

      return {claimedToken: claim.claimedToken, projectId: claim.projectId, status: 'completed', workerId}
    }

    if (executionMode === 'incremental') {
      await dependencies.refreshService.refreshProjectScopeArticles(claim.projectId, dirtyArticleIds)
      await dependencies.refreshService.refreshJudgmentFactsForProjectClaim({
        claimedToken: claim.claimedToken,
        lastCompletedToken: claim.lastCompletedToken,
        projectId: claim.projectId,
      })
      await dependencies.refreshService.refreshProjectArticleServingForArticles(claim.projectId, dirtyArticleIds)
    } else if (executionMode === 'full') {
      await dependencies.refreshService.refreshProject(claim.projectId)
      await dependencies.refreshService.refreshJudgmentFactsForProjectClaim({
        claimedToken: claim.claimedToken,
        lastCompletedToken: claim.lastCompletedToken,
        projectId: claim.projectId,
      })
    }

    if (executionMode === 'full') {
      await dependencies.stateService.completeProjectRefresh({
        completedToken: claim.claimedToken,
        now: getWorkerNow(options.now),
        projectId: claim.projectId,
        workerId,
      })
    } else {
      await dependencies.stateService.completeDirtyArticleBatchForClaim({
        articleIds: dirtyArticleIds,
        claimedToken: claim.claimedToken,
        now: getWorkerNow(options.now),
        projectId: claim.projectId,
        workerId,
      })
    }
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
  defaultProjectMartRefreshWorkerHeartbeatMs,
  defaultProjectMartRefreshWorkerIncrementalArticleThreshold,
  defaultProjectMartRefreshWorkerLeaseMs,
  defaultProjectMartRefreshWorkerPollIntervalMs,
  getProjectMartRefreshExecutionMode,
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

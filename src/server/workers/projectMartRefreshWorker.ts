import {hostname} from 'node:os'

import {sleep} from '../../utils/sleep.ts'
import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
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
  completeProjectRefresh: (params: {
    completedToken: number
    now?: Date
    projectId: string
    workerId: string
  }) => Promise<unknown>
  failProjectRefresh: (params: {error: string; now?: Date; projectId: string; workerId: string}) => Promise<unknown>
  getDirtyArticlesForClaim: (params: {
    claimedToken: number
    lastCompletedToken: number
    projectId: string
  }) => Promise<Array<{articleId: string}>>
  heartbeatClaim: (params: {
    leaseMs: number
    now?: Date
    projectId: string
    workerId: string
  }) => Promise<ProjectRefreshClaim | null>
}

type ProjectMartRefreshRunnerService = {
  refreshJudgmentArticle: (articleId: string) => Promise<void>
  refreshProject: (projectId: string) => Promise<void>
}

type ProjectMartRefreshWorkerDependencies = {
  refreshService: ProjectMartRefreshRunnerService
  sleep: typeof sleep
  stateService: ProjectMartRefreshStateWorkerService
}

type ProjectMartRefreshWorkerCycleOptions = {heartbeatMs?: number; leaseMs?: number; now?: Date; workerId?: string}

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
const defaultProjectMartRefreshWorkerPollIntervalMs = 2_000

const defaultProjectMartRefreshWorkerDependencies: ProjectMartRefreshWorkerDependencies = {
  refreshService: getDuckdbMartRefreshService(),
  sleep,
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

const refreshClaimArticles = async (
  articleIds: string[],
  refreshService: ProjectMartRefreshRunnerService,
): Promise<void> => {
  const [articleId = ''] = articleIds

  return articleId === ''
    ? Promise.resolve()
    : refreshService.refreshJudgmentArticle(articleId).then(() => {
        return refreshClaimArticles(articleIds.slice(1), refreshService)
      })
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
  const claim = await getClaimedProject(dependencies, {...options, workerId})

  if (claim === null) {
    return {projectId: null, status: 'idle', workerId}
  }

  const stopHeartbeat = startClaimHeartbeat(claim, dependencies, {...options, workerId})

  try {
    const dirtyArticles = await dependencies.stateService.getDirtyArticlesForClaim({
      claimedToken: claim.claimedToken,
      lastCompletedToken: claim.lastCompletedToken,
      projectId: claim.projectId,
    })

    await refreshClaimArticles(
      dirtyArticles.map((row) => {
        return row.articleId
      }),
      dependencies.refreshService,
    )
    await dependencies.refreshService.refreshProject(claim.projectId)
    await dependencies.stateService.completeProjectRefresh({
      completedToken: claim.claimedToken,
      now: getWorkerNow(options.now),
      projectId: claim.projectId,
      workerId,
    })

    return {claimedToken: claim.claimedToken, projectId: claim.projectId, status: 'completed', workerId}
  } catch (error) {
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

export const runProjectMartRefreshWorker = async (
  options: ProjectMartRefreshWorkerLoopOptions = {},
  dependencies: ProjectMartRefreshWorkerDependencies = defaultProjectMartRefreshWorkerDependencies,
): Promise<void> => {
  const cycleResult = await runProjectMartRefreshWorkerCycle(options, dependencies)

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

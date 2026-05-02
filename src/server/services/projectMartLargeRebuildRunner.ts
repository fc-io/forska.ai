import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getDuckdbQueueRuntimeMetricsSnapshot} from '../utils/duckdbService.ts'
import {
  getProjectMartLargeRebuildCycleQueueDelta,
  recordProjectMartLargeRebuildCycleMetric,
} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {
  getProjectMartLargeRebuildExecutor,
  type ProjectMartLargeRebuildBatchCursor,
  type ProjectMartLargeRebuildScopeBatchRow,
} from './projectMartLargeRebuildExecutor.ts'
import {getProjectMartLargeRebuildStateService, type LargeRebuildClaim} from './projectMartLargeRebuildStateService.ts'
import {getProjectMartRefreshStateService} from './projectMartRefreshStateService.ts'

type ProjectMartLargeRebuildRunnerDependencies = {
  executor: {
    finalizeProjectReviewServing: (projectId: string) => Promise<void>
    getNextBatchCursor: (rows: ProjectMartLargeRebuildScopeBatchRow[]) => ProjectMartLargeRebuildBatchCursor | null
    getProjectScopeMartBatch: (params: {
      batchSize?: number
      cursor?: ProjectMartLargeRebuildBatchCursor | null
      projectId: string
    }) => Promise<ProjectMartLargeRebuildScopeBatchRow[]>
    getProjectScopeSourceBatch: (params: {
      batchSize?: number
      cursor?: ProjectMartLargeRebuildBatchCursor | null
      projectId: string
    }) => Promise<ProjectMartLargeRebuildScopeBatchRow[]>
    rebuildProjectJudgmentFactBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectScopeBatch: (projectId: string, rows: ProjectMartLargeRebuildScopeBatchRow[]) => Promise<void>
    rebuildProjectPromptAnswerFactBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewAnswerDictionary: (projectId: string) => Promise<void>
    rebuildProjectReviewArticleFilterMemberBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewArticleRollupBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewServingBatch: (projectId: string, articleIds: string[]) => Promise<void>
    resetProjectJudgmentFact: (projectId: string) => Promise<void>
    resetProjectScope: (projectId: string) => Promise<void>
    resetProjectPromptAnswerFact: (projectId: string) => Promise<void>
    resetProjectReviewAnswerDictionary: (projectId: string) => Promise<void>
    resetProjectReviewArticleRollup: (projectId: string) => Promise<void>
    setupProjectReviewServingStaging: (projectId: string) => Promise<void>
  }
  largeRebuildStateService: {
    claimLargeRebuilds: (params: {
      leaseMs: number
      limit: number
      now?: Date
      projectId?: string
      workerId: string
    }) => Promise<LargeRebuildClaim[]>
    clearArchivedLargeRebuildStates: () => Promise<unknown>
    completeLargeRebuild: (params: {now?: Date; projectId: string; workerId: string}) => Promise<unknown>
    failLargeRebuild: (params: {error: string; now?: Date; projectId: string; workerId: string}) => Promise<unknown>
    getLargeRebuildState: (
      projectId: string,
    ) => Promise<{
      cursorArticleCreatedAt: Date | null
      cursorArticleId: string | null
      projectId: string
      rebuildPhase: string
      targetGeneration: number | null
    } | null>
    heartbeatLargeRebuildClaim: (params: {
      leaseMs: number
      now?: Date
      projectId: string
      workerId: string
    }) => Promise<LargeRebuildClaim | null>
    resetLargeRebuild: (params: {
      cursorArticleCreatedAt?: Date | null
      cursorArticleId?: string | null
      now?: Date
      projectId: string
      rebuildPhase?:
        | 'project_scope_article'
        | 'judgment_fact'
        | 'prompt_answer_fact'
        | 'review_answer_dictionary'
        | 'review_article_filter_member'
        | 'review_article_rollup'
        | 'review_article_serving'
      targetGeneration?: number | null
    }) => Promise<unknown>
  }
  refreshStateService: {
    finalizeProjectRefreshAfterLargeRebuild: (params: {
      completedToken: number
      now?: Date
      projectId: string
    }) => Promise<unknown>
  }
  sqliteService: {publishProjectRefreshAck: (params: {ackToken: number | null; projectId: string}) => Promise<number>}
}

type ProjectMartLargeRebuildRunnerOptions = {
  batchSize?: number
  heartbeatMs?: number
  leaseMs?: number
  now?: Date
  projectId?: string
  workerId: string
}

type ProjectMartLargeRebuildRunnerResult =
  | {projectId: null; status: 'idle'; workerId: string}
  | {
      articleCount: number
      nextCursor: ProjectMartLargeRebuildBatchCursor | null
      projectId: string
      status: 'progressed'
      workerId: string
    }
  | {projectId: string; status: 'completed'; workerId: string}
  | {error: string; projectId: string; status: 'failed'; workerId: string}

const defaultLeaseMs = 30_000
const defaultHeartbeatMs = 10_000

const defaultDependencies: ProjectMartLargeRebuildRunnerDependencies = {
  executor: getProjectMartLargeRebuildExecutor(),
  largeRebuildStateService: getProjectMartLargeRebuildStateService(),
  refreshStateService: getProjectMartRefreshStateService(),
  sqliteService: getJudgmentJobSqliteService(),
}

const getNow = (now?: Date) => {
  return now ?? new Date()
}

const getErrorText = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getCursorDateValue = (value: Date | string | null) => {
  return value === null || value instanceof Date ? value : new Date(value)
}

const startHeartbeat = (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
) => {
  const interval = setInterval(() => {
    return void dependencies.largeRebuildStateService.heartbeatLargeRebuildClaim({
      leaseMs: options.leaseMs ?? defaultLeaseMs,
      now: getNow(),
      projectId: claim.projectId,
      workerId: claim.workerId,
    })
  }, options.heartbeatMs ?? defaultHeartbeatMs)

  interval.unref()

  return () => {
    clearInterval(interval)
  }
}

const runProjectScopeArticlePhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.resetProjectScope(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeSourceBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      now: getNow(options.now),
      projectId: claim.projectId,
      rebuildPhase: 'judgment_fact',
      targetGeneration: rebuildState.targetGeneration,
    })
    return {
      articleCount: 0,
      nextCursor: null,
      projectId: claim.projectId,
      status: 'progressed',
      workerId: options.workerId,
    }
  }

  await dependencies.executor.rebuildProjectScopeBatch(claim.projectId, batchRows)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)

  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
    cursorArticleId: nextCursor?.articleId ?? null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'project_scope_article',
    targetGeneration: rebuildState.targetGeneration,
  })

  return {
    articleCount: batchRows.length,
    nextCursor,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

const runJudgmentFactPhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.resetProjectJudgmentFact(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      now: getNow(options.now),
      projectId: claim.projectId,
      rebuildPhase: 'prompt_answer_fact',
      targetGeneration: rebuildState.targetGeneration,
    })
    return {
      articleCount: 0,
      nextCursor: null,
      projectId: claim.projectId,
      status: 'progressed',
      workerId: options.workerId,
    }
  }

  const articleIds = batchRows.map((row) => {
    return row.articleId
  })
  await dependencies.executor.rebuildProjectJudgmentFactBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)

  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
    cursorArticleId: nextCursor?.articleId ?? null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'judgment_fact',
    targetGeneration: rebuildState.targetGeneration,
  })

  return {
    articleCount: articleIds.length,
    nextCursor,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

const runPromptAnswerFactPhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.resetProjectPromptAnswerFact(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      now: getNow(options.now),
      projectId: claim.projectId,
      rebuildPhase: 'review_answer_dictionary',
      targetGeneration: rebuildState.targetGeneration,
    })
    return {
      articleCount: 0,
      nextCursor: null,
      projectId: claim.projectId,
      status: 'progressed',
      workerId: options.workerId,
    }
  }

  const articleIds = batchRows.map((row) => {
    return row.articleId
  })
  await dependencies.executor.rebuildProjectPromptAnswerFactBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)

  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
    cursorArticleId: nextCursor?.articleId ?? null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'prompt_answer_fact',
    targetGeneration: rebuildState.targetGeneration,
  })

  return {
    articleCount: articleIds.length,
    nextCursor,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

const runReviewAnswerDictionaryPhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  await dependencies.executor.resetProjectReviewAnswerDictionary(claim.projectId)
  await dependencies.executor.rebuildProjectReviewAnswerDictionary(claim.projectId)
  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: null,
    cursorArticleId: null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'review_article_filter_member',
  })
  return {
    articleCount: 0,
    nextCursor: null,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

const runReviewArticleFilterMemberPhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.setupProjectReviewServingStaging(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      now: getNow(options.now),
      projectId: claim.projectId,
      rebuildPhase: 'review_article_rollup',
    })
    return {
      articleCount: 0,
      nextCursor: null,
      projectId: claim.projectId,
      status: 'progressed',
      workerId: options.workerId,
    }
  }

  const articleIds = batchRows.map((row) => {
    return row.articleId
  })
  await dependencies.executor.rebuildProjectReviewArticleFilterMemberBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
    cursorArticleId: nextCursor?.articleId ?? null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'review_article_filter_member',
  })
  return {
    articleCount: articleIds.length,
    nextCursor,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

const runReviewArticleRollupPhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.resetProjectReviewArticleRollup(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      now: getNow(options.now),
      projectId: claim.projectId,
      rebuildPhase: 'review_article_serving',
    })
    return {
      articleCount: 0,
      nextCursor: null,
      projectId: claim.projectId,
      status: 'progressed',
      workerId: options.workerId,
    }
  }

  const articleIds = batchRows.map((row) => {
    return row.articleId
  })
  await dependencies.executor.rebuildProjectReviewArticleRollupBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
    cursorArticleId: nextCursor?.articleId ?? null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'review_article_rollup',
  })
  return {
    articleCount: articleIds.length,
    nextCursor,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

const runReviewArticleServingPhase = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}
  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.executor.finalizeProjectReviewServing(claim.projectId)
    await dependencies.refreshStateService.finalizeProjectRefreshAfterLargeRebuild({
      completedToken: claim.refreshToken,
      now: getNow(options.now),
      projectId: claim.projectId,
    })
    await dependencies.largeRebuildStateService.completeLargeRebuild({
      now: getNow(options.now),
      projectId: claim.projectId,
      workerId: options.workerId,
    })
    await dependencies.sqliteService.publishProjectRefreshAck({
      ackToken: claim.refreshToken,
      projectId: claim.projectId,
    })
    return {projectId: claim.projectId, status: 'completed', workerId: options.workerId}
  }

  const articleIds = batchRows.map((row) => {
    return row.articleId
  })
  await dependencies.executor.rebuildProjectReviewServingBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  await dependencies.largeRebuildStateService.resetLargeRebuild({
    cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
    cursorArticleId: nextCursor?.articleId ?? null,
    now: getNow(options.now),
    projectId: claim.projectId,
    rebuildPhase: 'review_article_serving',
  })
  return {
    articleCount: articleIds.length,
    nextCursor,
    projectId: claim.projectId,
    status: 'progressed',
    workerId: options.workerId,
  }
}

export const runProjectMartLargeRebuildCycle = async (
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies = defaultDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const startedQueueMetrics = getDuckdbQueueRuntimeMetricsSnapshot()

  const [claim] = await dependencies.largeRebuildStateService.claimLargeRebuilds({
    leaseMs: options.leaseMs ?? defaultLeaseMs,
    limit: 1,
    now: options.now,
    projectId: options.projectId,
    workerId: options.workerId,
  })

  if (!claim) {
    const result = {
      projectId: null,
      status: 'idle',
      workerId: options.workerId,
    } satisfies ProjectMartLargeRebuildRunnerResult
    recordProjectMartLargeRebuildCycleMetric({
      articleCount: 0,
      durationMs: Date.now() - startedAtMs,
      duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
        finished: getDuckdbQueueRuntimeMetricsSnapshot(),
        started: startedQueueMetrics,
      }),
      endedAt: new Date().toISOString(),
      error: null,
      phase: null,
      projectId: null,
      startedAt,
      status: result.status,
      workerId: options.workerId,
    })
    return result
  }

  const stopHeartbeat = startHeartbeat(claim, options, dependencies)

  try {
    let result: ProjectMartLargeRebuildRunnerResult

    if (claim.rebuildPhase === 'project_scope_article') {
      result = await runProjectScopeArticlePhase(claim, options, dependencies)
    } else if (claim.rebuildPhase === 'judgment_fact') {
      result = await runJudgmentFactPhase(claim, options, dependencies)
    } else if (claim.rebuildPhase === 'prompt_answer_fact') {
      result = await runPromptAnswerFactPhase(claim, options, dependencies)
    } else if (claim.rebuildPhase === 'review_answer_dictionary') {
      result = await runReviewAnswerDictionaryPhase(claim, options, dependencies)
    } else if (claim.rebuildPhase === 'review_article_filter_member') {
      result = await runReviewArticleFilterMemberPhase(claim, options, dependencies)
    } else if (claim.rebuildPhase === 'review_article_rollup') {
      result = await runReviewArticleRollupPhase(claim, options, dependencies)
    } else if (claim.rebuildPhase === 'review_article_serving') {
      result = await runReviewArticleServingPhase(claim, options, dependencies)
    } else {
      throw new Error('Unsupported large rebuild phase')
    }

    recordProjectMartLargeRebuildCycleMetric({
      articleCount: result.status === 'progressed' ? result.articleCount : 0,
      durationMs: Date.now() - startedAtMs,
      duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
        finished: getDuckdbQueueRuntimeMetricsSnapshot(),
        started: startedQueueMetrics,
      }),
      endedAt: new Date().toISOString(),
      error: null,
      phase: claim.rebuildPhase,
      projectId: claim.projectId,
      startedAt,
      status: result.status,
      workerId: options.workerId,
    })

    return result
  } catch (error) {
    const errorText = getErrorText(error)
    await dependencies.largeRebuildStateService.failLargeRebuild({
      error: errorText,
      now: getNow(options.now),
      projectId: claim.projectId,
      workerId: options.workerId,
    })
    recordProjectMartLargeRebuildCycleMetric({
      articleCount: 0,
      durationMs: Date.now() - startedAtMs,
      duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
        finished: getDuckdbQueueRuntimeMetricsSnapshot(),
        started: startedQueueMetrics,
      }),
      endedAt: new Date().toISOString(),
      error: errorText,
      phase: claim.rebuildPhase,
      projectId: claim.projectId,
      startedAt,
      status: 'failed',
      workerId: options.workerId,
    })
    return {error: errorText, projectId: claim.projectId, status: 'failed', workerId: options.workerId}
  } finally {
    stopHeartbeat()
  }
}

export type {
  ProjectMartLargeRebuildRunnerDependencies,
  ProjectMartLargeRebuildRunnerOptions,
  ProjectMartLargeRebuildRunnerResult,
}

import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getDuckdbQueueRuntimeMetricsSnapshot, getDuckdbTempSpillMetricsSnapshot} from '../utils/duckdbService.ts'
import {
  getProjectMartLargeRebuildCycleQueueDelta,
  recordProjectMartLargeRebuildCycleMetric,
} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {getDuckdbMartMaintenanceService} from './getDuckdbMartMaintenanceService.ts'
import {getProjectMartDirtyRefreshStateService} from './projectMartDirtyRefreshStateService.ts'
import {
  getProjectMartLargeRebuildExecutor,
  type ProjectMartLargeRebuildBatchCursor,
  type ProjectMartLargeRebuildScopeBatchRow,
} from './projectMartLargeRebuildExecutor.ts'
import {getProjectMartLargeRebuildStateService, type LargeRebuildClaim} from './projectMartLargeRebuildStateService.ts'

type ProjectMartLargeRebuildRunnerDependencies = {
  archivedProjectCleanupService: {
    purgeNextArchivedProjectMartBatch: () => Promise<{deletedRowCount: number; projectId: string | null}>
  }
  executor: {
    cleanupProjectReviewServingGenerationsBatch: (params?: {
      batchSize?: number
      projectId?: string
      leaseMs?: number
      now?: Date
      workerId?: string
    }) => Promise<{deletedRowCount: number}>
    createProjectPromptAnswerFactLookupIndex: () => Promise<void>
    finalizeProjectReviewServing: (
      projectId: string,
      targetGeneration: number,
      guard?: {
        expectedRebuildPhase?: string
        expectedRefreshToken?: number
        expectedTargetGeneration?: number | null
        now?: Date
        workerId?: string
      },
    ) => Promise<boolean | undefined>
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
    rebuildProjectReviewAnswerDictionaryBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewArticleFilterMemberBatch: (
      projectId: string,
      articleIds: string[],
      targetGeneration: number,
    ) => Promise<void>
    rebuildProjectReviewArticleRollupBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewServingBatch: (
      projectId: string,
      articleIds: string[],
      targetGeneration: number,
    ) => Promise<void>
    resetProjectScope: (projectId: string) => Promise<void>
    resetProjectPromptAnswerFact: (projectId: string) => Promise<void>
    resetProjectReviewArticleRollup: (projectId: string) => Promise<void>
    setupProjectReviewServingStaging: (projectId: string, targetGeneration: number) => Promise<void>
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
    completeLargeRebuild: (params: {
      expectedRebuildPhase?: string
      expectedRefreshToken?: number
      expectedTargetGeneration?: number | null
      now?: Date
      projectId: string
      workerId: string
    }) => Promise<unknown>
    ensureLargeRebuildTargetGeneration: (params: {
      now?: Date
      projectId: string
    }) => Promise<{
      cursorArticleCreatedAt: Date | null
      cursorArticleId: string | null
      projectId: string
      rebuildPhase: string
      sourceDirtyToken?: number | null
      sourceHighWaterDirtyToken?: number | null
      targetGeneration: number | null
    } | null>
    failLargeRebuild: (params: {
      error: string
      expectedRebuildPhase?: string
      expectedRefreshToken?: number
      expectedTargetGeneration?: number | null
      now?: Date
      projectId: string
      workerId: string
    }) => Promise<unknown>
    getLargeRebuildState: (
      projectId: string,
    ) => Promise<{
      cursorArticleCreatedAt: Date | null
      cursorArticleId: string | null
      projectId: string
      rebuildPhase: string
      sourceDirtyToken?: number | null
      sourceHighWaterDirtyToken?: number | null
      targetGeneration: number | null
    } | null>
    heartbeatLargeRebuildClaim: (params: {
      leaseMs: number
      now?: Date
      projectId: string
      expectedRebuildPhase?: string
      expectedRefreshToken?: number
      expectedTargetGeneration?: number | null
      workerId: string
    }) => Promise<LargeRebuildClaim | null>
    recordLargeRebuildFrozenScope: (params: {
      expectedRebuildPhase?: string
      expectedRefreshToken?: number
      expectedTargetGeneration?: number | null
      now?: Date
      projectId: string
      workerId: string
    }) => Promise<{
      projectId: string
      sourceDirtyToken?: number | null
      sourceHighWaterDirtyToken?: number | null
    } | null>
    resetLargeRebuild: (params: {
      cursorArticleCreatedAt?: Date | null
      cursorArticleId?: string | null
      expectedRebuildPhase?: string
      expectedRefreshToken?: number
      expectedTargetGeneration?: number | null
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
      workerId?: string
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
  | {cleanupRowCount: number; projectId: string | null; status: 'maintenance'; workerId: string}
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
  archivedProjectCleanupService: getDuckdbMartMaintenanceService(),
  executor: getProjectMartLargeRebuildExecutor(),
  largeRebuildStateService: getProjectMartLargeRebuildStateService(),
  refreshStateService: getProjectMartDirtyRefreshStateService(),
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

const getMetricCursorDateValue = (value: Date | string | null) => {
  return value instanceof Date ? value.toISOString() : value
}

const getLastCommittedCursor = (result: ProjectMartLargeRebuildRunnerResult) => {
  return result.status === 'progressed' && result.nextCursor !== null
    ? {
        articleCreatedAt: getMetricCursorDateValue(result.nextCursor.articleCreatedAt),
        articleId: result.nextCursor.articleId,
      }
    : null
}

const getClaimFence = (claim: LargeRebuildClaim, targetGeneration?: number | null) => {
  return {
    expectedRebuildPhase: claim.rebuildPhase,
    expectedRefreshToken: claim.refreshToken,
    expectedTargetGeneration: targetGeneration === undefined ? (claim.targetGeneration ?? null) : targetGeneration,
    projectId: claim.projectId,
    workerId: claim.workerId,
  }
}

const getStateTargetGeneration = (claim: LargeRebuildClaim, rebuildState: {targetGeneration: number | null}) => {
  return claim.targetGeneration === undefined ? rebuildState.targetGeneration : claim.targetGeneration
}

const getCompletionDirtyToken = (
  claim: LargeRebuildClaim,
  rebuildState: {sourceHighWaterDirtyToken?: number | null},
) => {
  return rebuildState.sourceHighWaterDirtyToken ?? claim.refreshToken
}

const assertLargeRebuildTransition = (result: unknown, projectId: string) => {
  if (!result) {
    throw new Error(`Large rebuild claim was superseded or expired for ${projectId}`)
  }

  return result
}

const ensureProjectReviewServingTargetGeneration = async (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
) => {
  const rebuildState = await dependencies.largeRebuildStateService.ensureLargeRebuildTargetGeneration({
    ...getClaimFence(claim, claim.targetGeneration ?? null),
    now: getNow(options.now),
    projectId: claim.projectId,
  })

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  if (rebuildState.targetGeneration === null) {
    throw new Error(`Missing large rebuild target generation for ${claim.projectId}`)
  }

  return rebuildState.targetGeneration
}

const startHeartbeat = (
  claim: LargeRebuildClaim,
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies,
) => {
  const interval = setInterval(() => {
    return void dependencies.largeRebuildStateService.heartbeatLargeRebuildClaim({
      ...getClaimFence(claim),
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
  const expectedTargetGeneration = getStateTargetGeneration(claim, rebuildState)

  if (initialCursor === null) {
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.recordLargeRebuildFrozenScope({
        ...getClaimFence(claim, expectedTargetGeneration),
        now: getNow(options.now),
      }),
      claim.projectId,
    )
    await dependencies.executor.resetProjectScope(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeSourceBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.resetLargeRebuild({
        ...getClaimFence(claim, expectedTargetGeneration),
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        now: getNow(options.now),
        rebuildPhase: 'judgment_fact',
        targetGeneration: rebuildState.targetGeneration,
      }),
      claim.projectId,
    )
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

  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, expectedTargetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'project_scope_article',
      targetGeneration: rebuildState.targetGeneration,
    }),
    claim.projectId,
  )

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
  const expectedTargetGeneration = getStateTargetGeneration(claim, rebuildState)

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.resetLargeRebuild({
        ...getClaimFence(claim, expectedTargetGeneration),
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        now: getNow(options.now),
        rebuildPhase: 'prompt_answer_fact',
        targetGeneration: rebuildState.targetGeneration,
      }),
      claim.projectId,
    )
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

  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, expectedTargetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'judgment_fact',
      targetGeneration: rebuildState.targetGeneration,
    }),
    claim.projectId,
  )

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
  const expectedTargetGeneration = getStateTargetGeneration(claim, rebuildState)

  if (initialCursor === null) {
    await dependencies.executor.resetProjectPromptAnswerFact(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    await dependencies.executor.createProjectPromptAnswerFactLookupIndex()
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.resetLargeRebuild({
        ...getClaimFence(claim, expectedTargetGeneration),
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        now: getNow(options.now),
        rebuildPhase: 'review_answer_dictionary',
        targetGeneration: rebuildState.targetGeneration,
      }),
      claim.projectId,
    )
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

  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, expectedTargetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'prompt_answer_fact',
      targetGeneration: rebuildState.targetGeneration,
    }),
    claim.projectId,
  )

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
  const rebuildState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)

  if (!rebuildState) {
    throw new Error(`Missing large rebuild state for ${claim.projectId}`)
  }

  const initialCursor =
    rebuildState.cursorArticleId === null
      ? null
      : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}
  const expectedTargetGeneration = getStateTargetGeneration(claim, rebuildState)

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.resetLargeRebuild({
        ...getClaimFence(claim, expectedTargetGeneration),
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        now: getNow(options.now),
        rebuildPhase: 'review_article_filter_member',
        targetGeneration: rebuildState.targetGeneration,
      }),
      claim.projectId,
    )
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
  await dependencies.executor.rebuildProjectReviewAnswerDictionaryBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, expectedTargetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'review_answer_dictionary',
      targetGeneration: rebuildState.targetGeneration,
    }),
    claim.projectId,
  )
  return {
    articleCount: articleIds.length,
    nextCursor,
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
  const targetGeneration = await ensureProjectReviewServingTargetGeneration(claim, options, dependencies)

  if (initialCursor === null) {
    await dependencies.executor.setupProjectReviewServingStaging(claim.projectId, targetGeneration)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.resetLargeRebuild({
        ...getClaimFence(claim, targetGeneration),
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        now: getNow(options.now),
        rebuildPhase: 'review_article_rollup',
        targetGeneration,
      }),
      claim.projectId,
    )
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
  await dependencies.executor.rebuildProjectReviewArticleFilterMemberBatch(
    claim.projectId,
    articleIds,
    targetGeneration,
  )
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, targetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'review_article_filter_member',
      targetGeneration,
    }),
    claim.projectId,
  )
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
  const expectedTargetGeneration = getStateTargetGeneration(claim, rebuildState)

  if (initialCursor === null) {
    await dependencies.executor.resetProjectReviewArticleRollup(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.resetLargeRebuild({
        ...getClaimFence(claim, expectedTargetGeneration),
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        now: getNow(options.now),
        rebuildPhase: 'review_article_serving',
        targetGeneration: rebuildState.targetGeneration,
      }),
      claim.projectId,
    )
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
  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, expectedTargetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'review_article_rollup',
      targetGeneration: rebuildState.targetGeneration,
    }),
    claim.projectId,
  )
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
  const targetGeneration = await ensureProjectReviewServingTargetGeneration(claim, options, dependencies)
  const batchRows = await dependencies.executor.getProjectScopeMartBatch({
    batchSize: options.batchSize,
    cursor: initialCursor,
    projectId: claim.projectId,
  })

  if (batchRows.length === 0) {
    assertLargeRebuildTransition(
      await dependencies.executor.finalizeProjectReviewServing(claim.projectId, targetGeneration, {
        ...getClaimFence(claim, targetGeneration),
        now: getNow(options.now),
      }),
      claim.projectId,
    )
    assertLargeRebuildTransition(
      await dependencies.largeRebuildStateService.completeLargeRebuild({
        ...getClaimFence(claim, targetGeneration),
        now: getNow(options.now),
        workerId: options.workerId,
      }),
      claim.projectId,
    )

    const completedToken = getCompletionDirtyToken(claim, rebuildState)
    const completedRefreshState = await dependencies.refreshStateService.finalizeProjectRefreshAfterLargeRebuild({
      completedToken,
      now: getNow(options.now),
      projectId: claim.projectId,
    })

    if (completedRefreshState) {
      await dependencies.sqliteService.publishProjectRefreshAck({ackToken: completedToken, projectId: claim.projectId})
    }

    return {projectId: claim.projectId, status: 'completed', workerId: options.workerId}
  }

  const articleIds = batchRows.map((row) => {
    return row.articleId
  })
  await dependencies.executor.rebuildProjectReviewServingBatch(claim.projectId, articleIds, targetGeneration)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  assertLargeRebuildTransition(
    await dependencies.largeRebuildStateService.resetLargeRebuild({
      ...getClaimFence(claim, targetGeneration),
      cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt),
      cursorArticleId: nextCursor?.articleId ?? null,
      now: getNow(options.now),
      rebuildPhase: 'review_article_serving',
      targetGeneration,
    }),
    claim.projectId,
  )
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
    const cleanupResult = await dependencies.executor.cleanupProjectReviewServingGenerationsBatch({
      batchSize: options.batchSize,
      leaseMs: options.leaseMs ?? defaultLeaseMs,
      now: getNow(options.now),
      projectId: options.projectId,
      workerId: options.workerId,
    })

    if (cleanupResult.deletedRowCount > 0) {
      const result = {
        cleanupRowCount: cleanupResult.deletedRowCount,
        projectId: options.projectId ?? null,
        status: 'maintenance',
        workerId: options.workerId,
      } satisfies ProjectMartLargeRebuildRunnerResult

      recordProjectMartLargeRebuildCycleMetric({
        articleCount: cleanupResult.deletedRowCount,
        committedRowCount: cleanupResult.deletedRowCount,
        durationMs: Date.now() - startedAtMs,
        duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
          finished: getDuckdbQueueRuntimeMetricsSnapshot(),
          started: startedQueueMetrics,
        }),
        endedAt: new Date().toISOString(),
        error: null,
        lastCommittedCursor: null,
        phase: 'review_article_serving_generation_cleanup',
        projectId: result.projectId,
        startedAt,
        status: result.status,
        tempSpill: getDuckdbTempSpillMetricsSnapshot(),
        workerId: options.workerId,
      })

      return result
    }

    const archivedCleanupResult = await dependencies.archivedProjectCleanupService.purgeNextArchivedProjectMartBatch()

    if (archivedCleanupResult.deletedRowCount > 0) {
      const result = {
        cleanupRowCount: archivedCleanupResult.deletedRowCount,
        projectId: archivedCleanupResult.projectId,
        status: 'maintenance',
        workerId: options.workerId,
      } satisfies ProjectMartLargeRebuildRunnerResult

      recordProjectMartLargeRebuildCycleMetric({
        articleCount: archivedCleanupResult.deletedRowCount,
        committedRowCount: archivedCleanupResult.deletedRowCount,
        durationMs: Date.now() - startedAtMs,
        duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
          finished: getDuckdbQueueRuntimeMetricsSnapshot(),
          started: startedQueueMetrics,
        }),
        endedAt: new Date().toISOString(),
        error: null,
        lastCommittedCursor: null,
        phase: 'archived_project_mart_cleanup',
        projectId: result.projectId,
        startedAt,
        status: result.status,
        tempSpill: getDuckdbTempSpillMetricsSnapshot(),
        workerId: options.workerId,
      })

      return result
    }

    const result = {
      projectId: null,
      status: 'idle',
      workerId: options.workerId,
    } satisfies ProjectMartLargeRebuildRunnerResult
    recordProjectMartLargeRebuildCycleMetric({
      articleCount: 0,
      committedRowCount: 0,
      durationMs: Date.now() - startedAtMs,
      duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
        finished: getDuckdbQueueRuntimeMetricsSnapshot(),
        started: startedQueueMetrics,
      }),
      endedAt: new Date().toISOString(),
      error: null,
      lastCommittedCursor: null,
      phase: null,
      projectId: null,
      startedAt,
      status: result.status,
      tempSpill: getDuckdbTempSpillMetricsSnapshot(),
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
      committedRowCount: result.status === 'progressed' ? result.articleCount : 0,
      durationMs: Date.now() - startedAtMs,
      duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
        finished: getDuckdbQueueRuntimeMetricsSnapshot(),
        started: startedQueueMetrics,
      }),
      endedAt: new Date().toISOString(),
      error: null,
      lastCommittedCursor: getLastCommittedCursor(result),
      phase: claim.rebuildPhase,
      projectId: claim.projectId,
      startedAt,
      status: result.status,
      tempSpill: getDuckdbTempSpillMetricsSnapshot(),
      workerId: options.workerId,
    })

    return result
  } catch (error) {
    const errorText = getErrorText(error)
    const failureState = await dependencies.largeRebuildStateService.getLargeRebuildState(claim.projectId)
    await dependencies.largeRebuildStateService.failLargeRebuild({
      error: errorText,
      ...getClaimFence(claim, failureState?.targetGeneration ?? claim.targetGeneration ?? null),
      now: getNow(options.now),
      workerId: options.workerId,
    })
    recordProjectMartLargeRebuildCycleMetric({
      articleCount: 0,
      committedRowCount: 0,
      durationMs: Date.now() - startedAtMs,
      duckdbQueues: getProjectMartLargeRebuildCycleQueueDelta({
        finished: getDuckdbQueueRuntimeMetricsSnapshot(),
        started: startedQueueMetrics,
      }),
      endedAt: new Date().toISOString(),
      error: errorText,
      lastCommittedCursor: null,
      phase: claim.rebuildPhase,
      projectId: claim.projectId,
      startedAt,
      status: 'failed',
      tempSpill: getDuckdbTempSpillMetricsSnapshot(),
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

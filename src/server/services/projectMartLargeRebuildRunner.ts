import {getProjectMartLargeRebuildExecutor, type ProjectMartLargeRebuildBatchCursor, type ProjectMartLargeRebuildScopeBatchRow} from './projectMartLargeRebuildExecutor.ts'
import {
  getProjectMartLargeRebuildStateService,
  type LargeRebuildClaim,
} from './projectMartLargeRebuildStateService.ts'

type ProjectMartLargeRebuildRunnerDependencies = {
  executor: {
    finalizeProjectReviewServing: (projectId: string) => Promise<void>
    getNextBatchCursor: (rows: ProjectMartLargeRebuildScopeBatchRow[]) => ProjectMartLargeRebuildBatchCursor | null
    getProjectScopeSourceBatch: (params: {
      batchSize?: number
      cursor?: ProjectMartLargeRebuildBatchCursor | null
      projectId: string
    }) => Promise<ProjectMartLargeRebuildScopeBatchRow[]>
    rebuildProjectPromptAnswerFactBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewAnswerDictionary: (projectId: string) => Promise<void>
    rebuildProjectReviewArticleFilterMemberBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewArticleRollupBatch: (projectId: string, articleIds: string[]) => Promise<void>
    rebuildProjectReviewServingBatch: (projectId: string, articleIds: string[]) => Promise<void>
    resetProjectPromptAnswerFact: (projectId: string) => Promise<void>
    resetProjectReviewAnswerDictionary: (projectId: string) => Promise<void>
    resetProjectReviewArticleRollup: (projectId: string) => Promise<void>
    setupProjectReviewServingStaging: (projectId: string) => Promise<void>
  }
  largeRebuildStateService: {
    claimLargeRebuilds: (params: {leaseMs: number; limit: number; now?: Date; workerId: string}) => Promise<LargeRebuildClaim[]>
    completeLargeRebuild: (params: {now?: Date; projectId: string; workerId: string}) => Promise<unknown>
    failLargeRebuild: (params: {error: string; now?: Date; projectId: string; workerId: string}) => Promise<unknown>
    getLargeRebuildState: (projectId: string) => Promise<{
      cursorArticleCreatedAt: Date | null
      cursorArticleId: string | null
      projectId: string
      rebuildPhase: string
      targetGeneration: number | null
    } | null>
    heartbeatLargeRebuildClaim: (params: {leaseMs: number; now?: Date; projectId: string; workerId: string}) => Promise<LargeRebuildClaim | null>
    resetLargeRebuild: (params: {
      cursorArticleCreatedAt?: Date | null
      cursorArticleId?: string | null
      now?: Date
      projectId: string
      rebuildPhase?: 'judgment_fact' | 'prompt_answer_fact' | 'review_answer_dictionary' | 'review_article_filter_member' | 'review_article_rollup' | 'review_article_serving'
      targetGeneration?: number | null
    }) => Promise<unknown>
  }
}

type ProjectMartLargeRebuildRunnerOptions = {
  batchSize?: number
  heartbeatMs?: number
  leaseMs?: number
  now?: Date
  workerId: string
}

type ProjectMartLargeRebuildRunnerResult =
  | {projectId: null; status: 'idle'; workerId: string}
  | {articleCount: number; nextCursor: ProjectMartLargeRebuildBatchCursor | null; projectId: string; status: 'progressed'; workerId: string}
  | {projectId: string; status: 'completed'; workerId: string}
  | {error: string; projectId: string; status: 'failed'; workerId: string}

const defaultLeaseMs = 30_000
const defaultHeartbeatMs = 10_000

const defaultDependencies: ProjectMartLargeRebuildRunnerDependencies = {
  executor: getProjectMartLargeRebuildExecutor(),
  largeRebuildStateService: getProjectMartLargeRebuildStateService(),
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
      rebuildPhase: 'review_answer_dictionary',
      targetGeneration: rebuildState.targetGeneration,
    })
    return {articleCount: 0, nextCursor: null, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
  }

  const articleIds = batchRows.map((row) => row.articleId)
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

  return {articleCount: articleIds.length, nextCursor, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
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
  return {articleCount: 0, nextCursor: null, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
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

  const initialCursor = rebuildState.cursorArticleId === null ? null : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.setupProjectReviewServingStaging(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeSourceBatch({batchSize: options.batchSize, cursor: initialCursor, projectId: claim.projectId})

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({cursorArticleCreatedAt: null, cursorArticleId: null, now: getNow(options.now), projectId: claim.projectId, rebuildPhase: 'review_article_rollup'})
    return {articleCount: 0, nextCursor: null, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
  }

  const articleIds = batchRows.map((row) => row.articleId)
  await dependencies.executor.rebuildProjectReviewArticleFilterMemberBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  await dependencies.largeRebuildStateService.resetLargeRebuild({cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt), cursorArticleId: nextCursor?.articleId ?? null, now: getNow(options.now), projectId: claim.projectId, rebuildPhase: 'review_article_filter_member'})
  return {articleCount: articleIds.length, nextCursor, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
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

  const initialCursor = rebuildState.cursorArticleId === null ? null : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}

  if (initialCursor === null) {
    await dependencies.executor.resetProjectReviewArticleRollup(claim.projectId)
  }

  const batchRows = await dependencies.executor.getProjectScopeSourceBatch({batchSize: options.batchSize, cursor: initialCursor, projectId: claim.projectId})

  if (batchRows.length === 0) {
    await dependencies.largeRebuildStateService.resetLargeRebuild({cursorArticleCreatedAt: null, cursorArticleId: null, now: getNow(options.now), projectId: claim.projectId, rebuildPhase: 'review_article_serving'})
    return {articleCount: 0, nextCursor: null, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
  }

  const articleIds = batchRows.map((row) => row.articleId)
  await dependencies.executor.rebuildProjectReviewArticleRollupBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  await dependencies.largeRebuildStateService.resetLargeRebuild({cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt), cursorArticleId: nextCursor?.articleId ?? null, now: getNow(options.now), projectId: claim.projectId, rebuildPhase: 'review_article_rollup'})
  return {articleCount: articleIds.length, nextCursor, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
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

  const initialCursor = rebuildState.cursorArticleId === null ? null : {articleCreatedAt: rebuildState.cursorArticleCreatedAt, articleId: rebuildState.cursorArticleId}
  const batchRows = await dependencies.executor.getProjectScopeSourceBatch({batchSize: options.batchSize, cursor: initialCursor, projectId: claim.projectId})

  if (batchRows.length === 0) {
    await dependencies.executor.finalizeProjectReviewServing(claim.projectId)
    await dependencies.largeRebuildStateService.completeLargeRebuild({now: getNow(options.now), projectId: claim.projectId, workerId: options.workerId})
    return {projectId: claim.projectId, status: 'completed', workerId: options.workerId}
  }

  const articleIds = batchRows.map((row) => row.articleId)
  await dependencies.executor.rebuildProjectReviewServingBatch(claim.projectId, articleIds)
  const nextCursor = dependencies.executor.getNextBatchCursor(batchRows)
  await dependencies.largeRebuildStateService.resetLargeRebuild({cursorArticleCreatedAt: nextCursor === null ? null : getCursorDateValue(nextCursor.articleCreatedAt), cursorArticleId: nextCursor?.articleId ?? null, now: getNow(options.now), projectId: claim.projectId, rebuildPhase: 'review_article_serving'})
  return {articleCount: articleIds.length, nextCursor, projectId: claim.projectId, status: 'progressed', workerId: options.workerId}
}

export const runProjectMartLargeRebuildCycle = async (
  options: ProjectMartLargeRebuildRunnerOptions,
  dependencies: ProjectMartLargeRebuildRunnerDependencies = defaultDependencies,
): Promise<ProjectMartLargeRebuildRunnerResult> => {
  const [claim] = await dependencies.largeRebuildStateService.claimLargeRebuilds({
    leaseMs: options.leaseMs ?? defaultLeaseMs,
    limit: 1,
    now: options.now,
    workerId: options.workerId,
  })

  if (!claim) {
    return {projectId: null, status: 'idle', workerId: options.workerId}
  }

  const stopHeartbeat = startHeartbeat(claim, options, dependencies)

  try {
    if (claim.rebuildPhase === 'prompt_answer_fact') {
      return await runPromptAnswerFactPhase(claim, options, dependencies)
    }

    if (claim.rebuildPhase === 'review_answer_dictionary') {
      return await runReviewAnswerDictionaryPhase(claim, options, dependencies)
    }

    if (claim.rebuildPhase === 'review_article_filter_member') {
      return await runReviewArticleFilterMemberPhase(claim, options, dependencies)
    }

    if (claim.rebuildPhase === 'review_article_rollup') {
      return await runReviewArticleRollupPhase(claim, options, dependencies)
    }

    if (claim.rebuildPhase === 'review_article_serving') {
      return await runReviewArticleServingPhase(claim, options, dependencies)
    }

    throw new Error(`Unsupported large rebuild phase ${claim.rebuildPhase}`)
  } catch (error) {
    const errorText = getErrorText(error)
    await dependencies.largeRebuildStateService.failLargeRebuild({error: errorText, now: getNow(options.now), projectId: claim.projectId, workerId: options.workerId})
    return {error: errorText, projectId: claim.projectId, status: 'failed', workerId: options.workerId}
  } finally {
    stopHeartbeat()
  }
}

export type {ProjectMartLargeRebuildRunnerDependencies, ProjectMartLargeRebuildRunnerOptions, ProjectMartLargeRebuildRunnerResult}

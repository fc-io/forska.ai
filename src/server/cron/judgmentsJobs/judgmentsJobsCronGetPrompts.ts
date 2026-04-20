import {getUnassessedPairsFromOlap} from '../../../services/olap/unassessedArticlesOlap.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import type {JobCursor} from './judgmentJobSqliteService.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]; nextCursor: JobCursor | null}

const getPromptsLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const getPromptsComponent = 'judgmentsJobsCronGetPrompts'

const getUnassessedPairsCursor = (cursor: JobCursor | null) => {
  return cursor ? {...cursor, priorityBucket: Number(cursor.priorityBucket ?? 0)} : null
}

/**
 * Gets prompts (article × prompt pairs) that need to be judged for a project.
 *
 * Uses the OLAP layer to find unassessed pairs (articles without judgments for all prompts).
 * Uses cursor-based pagination to avoid re-fetching already-queued pairs.
 */
export const judgmentsJobsCronGetPrompts = async (
  projectId: string,
  jobId: string,
  numberOfPromptsToGet: number,
  cursor: JobCursor | null = null,
  preferRawFallback = false,
): Promise<QueuePromptsResult> => {
  const shouldPreferRawFallback = Boolean(preferRawFallback)
  const [projectResult, enabledPromptCount] = await Promise.all([
    getAppDatabaseService().queryJson<{id: string; archived: boolean}>(`
      SELECT id, archived
      FROM app.project
      WHERE id = '${escapeSqlString(projectId)}'
      LIMIT 1
    `),
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.project_prompt
      WHERE project_id = '${escapeSqlString(projectId)}'
        AND enabled = TRUE
    `),
  ])

  const [project] = projectResult

  if (!project) {
    if (numberOfPromptsToGet > 0) {
      getPromptsLogger.warn(`judgmentQueue.getPrompts.noProject.${jobId}`, '[getPrompts] project not found', {
        component: getPromptsComponent,
        event: 'noProject',
        jobId,
        projectId,
        requested: numberOfPromptsToGet,
      })
    }
    return {promptEntries: [], nextCursor: null}
  }

  if (project.archived) {
    if (numberOfPromptsToGet > 0) {
      getPromptsLogger.warn(`judgmentQueue.getPrompts.archived.${jobId}`, '[getPrompts] project archived', {
        component: getPromptsComponent,
        event: 'archivedProject',
        jobId,
        projectId,
        requested: numberOfPromptsToGet,
      })
    }
    return {promptEntries: [], nextCursor: null}
  }

  if (!enabledPromptCount[0] || enabledPromptCount[0].count === 0) {
    if (numberOfPromptsToGet > 0) {
      getPromptsLogger.warn(`judgmentQueue.getPrompts.noPrompts.${jobId}`, '[getPrompts] 0 enabled prompts', {
        component: getPromptsComponent,
        event: 'noEnabledPrompts',
        jobId,
        projectId,
        requested: numberOfPromptsToGet,
      })
    }
    return {promptEntries: [], nextCursor: null}
  }

  const cursorSummary = cursor
    ? {
        lastDate: cursor.lastDate.toISOString(),
        lastArticleId: cursor.lastArticleId.slice(0, 8),
        priorityBucket: cursor.priorityBucket ?? 0,
      }
    : null

  const slowLogMs = 30_000
  const startedAtMs = Date.now()
  const slowTimer = setTimeout(() => {
    getPromptsLogger.warn(`judgmentQueue.getPrompts.slowTimer.${jobId}`, '[getPrompts] slow OLAP query', {
      component: getPromptsComponent,
      event: 'slowOlapQueryTimer',
      jobId,
      projectId,
      requested: numberOfPromptsToGet,
      cursor: cursorSummary,
      olapDb: 'duckdb',
      runningForMs: Date.now() - startedAtMs,
    })
  }, slowLogMs)

  const result = await getUnassessedPairsFromOlap({
    projectId,
    jobId,
    numberOfPromptsToGet,
    cursor: getUnassessedPairsCursor(cursor),
    preferRawFallback: shouldPreferRawFallback,
  }).finally(() => {
    clearTimeout(slowTimer)
  })
  const durationMs = Date.now() - startedAtMs

  const nextCursorSummary = result.nextCursor
    ? {
        lastDate: result.nextCursor.lastDate.toISOString(),
        lastArticleId: result.nextCursor.lastArticleId.slice(0, 8),
        priorityBucket: result.nextCursor.priorityBucket,
      }
    : null

  const cursorAction = result.nextCursor ? 'advance' : cursor ? 'clear' : 'none'

  if (numberOfPromptsToGet > 0 && result.promptEntries.length === 0) {
    getPromptsLogger.warn(`judgmentQueue.getPrompts.empty.${jobId}`, '[getPrompts] OLAP returned 0 pairs', {
      component: getPromptsComponent,
      event: 'emptyOlapResult',
      projectId,
      jobId,
      requested: numberOfPromptsToGet,
      cursor: cursorSummary,
      nextCursor: nextCursorSummary,
      cursorAction,
      durationMs,
      preferRawFallback: shouldPreferRawFallback,
      olapDb: 'duckdb',
    })
  } else if (durationMs > 5_000) {
    getPromptsLogger.warn(`judgmentQueue.getPrompts.slow.${jobId}`, '[getPrompts] slow OLAP query', {
      component: getPromptsComponent,
      event: 'slowOlapQuery',
      projectId,
      jobId,
      requested: numberOfPromptsToGet,
      returned: result.promptEntries.length,
      cursor: cursorSummary,
      nextCursor: nextCursorSummary,
      cursorAction,
      durationMs,
      preferRawFallback: shouldPreferRawFallback,
      olapDb: 'duckdb',
    })
  }

  return {promptEntries: result.promptEntries, nextCursor: result.nextCursor}
}

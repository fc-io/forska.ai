import {getUnassessedPairsFromOlap} from '../../../services/olap/unassessedArticlesOlap.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import type {JobCursor} from './judgmentJobSqliteService.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]; nextCursor: JobCursor | null}

const getPromptsLogger = createRateLimitedLogger({windowMs: 30_000})

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
      getPromptsLogger.warn(`getPrompts:${jobId}:no-project`, '[getPrompts] project not found', {
        projectId,
        jobId,
        requested: numberOfPromptsToGet,
      })
    }
    return {promptEntries: [], nextCursor: null}
  }

  if (project.archived) {
    if (numberOfPromptsToGet > 0) {
      getPromptsLogger.warn(`getPrompts:${jobId}:archived`, '[getPrompts] project archived', {
        projectId,
        jobId,
        requested: numberOfPromptsToGet,
      })
    }
    return {promptEntries: [], nextCursor: null}
  }

  if (!enabledPromptCount[0] || enabledPromptCount[0].count === 0) {
    if (numberOfPromptsToGet > 0) {
      getPromptsLogger.warn(`getPrompts:${jobId}:no-prompts`, '[getPrompts] 0 enabled prompts', {
        projectId,
        jobId,
        requested: numberOfPromptsToGet,
      })
    }
    return {promptEntries: [], nextCursor: null}
  }

  const cursorSummary = cursor
    ? {lastDate: cursor.lastDate.toISOString(), lastArticleId: cursor.lastArticleId.slice(0, 8)}
    : null

  const slowLogMs = 30_000
  const startedAtMs = Date.now()
  const slowTimer = setTimeout(() => {
    console.warn('[getPrompts] slow OLAP query', {
      projectId,
      jobId,
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
    cursor,
    preferRawFallback: shouldPreferRawFallback,
  }).finally(() => {
    clearTimeout(slowTimer)
  })
  const durationMs = Date.now() - startedAtMs

  const nextCursorSummary = result.nextCursor
    ? {lastDate: result.nextCursor.lastDate.toISOString(), lastArticleId: result.nextCursor.lastArticleId.slice(0, 8)}
    : null

  const cursorAction = result.nextCursor ? 'advance' : cursor ? 'clear' : 'none'

  if (numberOfPromptsToGet > 0 && result.promptEntries.length === 0) {
    getPromptsLogger.warn(`getPrompts:${jobId}:empty`, '[getPrompts] OLAP returned 0 pairs', {
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
    getPromptsLogger.warn(`getPrompts:${jobId}:slow`, '[getPrompts] slow OLAP query', {
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

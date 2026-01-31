import {and, eq, sql} from 'drizzle-orm'

import * as schema from '../../../db/schema.ts'
import {getUnassessedPairsFromClickHouse} from '../../../services/clickhouse/unassessedArticlesClickHouse.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getJobCursor, type JobCursor} from './jobCursorStore.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]; nextCursor: JobCursor | null}

const getPromptsLogger = createRateLimitedLogger({windowMs: 30_000})

/**
 * Gets prompts (article × prompt pairs) that need to be judged for a project.
 *
 * Uses ClickHouse to find unassessed pairs (articles without judgments for all prompts).
 * Uses cursor-based pagination to avoid re-fetching already-queued pairs.
 */
export const judgmentsJobsCronGetPrompts = async (
  projectId: string,
  jobId: string,
  numberOfPromptsToGet: number,
): Promise<QueuePromptsResult> => {
  const db = getDatabase()

  const [projectResult, enabledPromptCount] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1),
    db
      .select({count: sql<number>`count(*)`})
      .from(schema.projectPrompts)
      .where(and(eq(schema.projectPrompts.projectId, projectId), eq(schema.projectPrompts.enabled, true))),
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

  const cursor = await getJobCursor(db, jobId)
  const cursorSummary = cursor
    ? {lastDate: cursor.lastDate.toISOString(), lastArticleId: cursor.lastArticleId.slice(0, 8)}
    : null

  const slowLogMs = 30_000
  const startedAtMs = Date.now()
  const slowTimer = setTimeout(() => {
    console.warn('[getPrompts] slow ClickHouse query', {
      projectId,
      jobId,
      requested: numberOfPromptsToGet,
      cursor: cursorSummary,
      runningForMs: Date.now() - startedAtMs,
    })
  }, slowLogMs)

  const result = await getUnassessedPairsFromClickHouse({projectId, jobId, numberOfPromptsToGet, cursor}).finally(
    () => {
      clearTimeout(slowTimer)
    },
  )
  const durationMs = Date.now() - startedAtMs

  const nextCursorSummary = result.nextCursor
    ? {lastDate: result.nextCursor.lastDate.toISOString(), lastArticleId: result.nextCursor.lastArticleId.slice(0, 8)}
    : null

  const cursorAction = result.nextCursor ? 'advance' : cursor ? 'clear' : 'none'

  if (numberOfPromptsToGet > 0 && result.promptEntries.length === 0) {
    getPromptsLogger.warn(`getPrompts:${jobId}:empty`, '[getPrompts] ClickHouse returned 0 pairs', {
      projectId,
      jobId,
      requested: numberOfPromptsToGet,
      cursor: cursorSummary,
      nextCursor: nextCursorSummary,
      cursorAction,
      durationMs,
    })
  } else if (durationMs > 5_000) {
    getPromptsLogger.warn(`getPrompts:${jobId}:slow`, '[getPrompts] slow ClickHouse query', {
      projectId,
      jobId,
      requested: numberOfPromptsToGet,
      returned: result.promptEntries.length,
      cursor: cursorSummary,
      nextCursor: nextCursorSummary,
      cursorAction,
      durationMs,
    })
  }

  return {promptEntries: result.promptEntries, nextCursor: result.nextCursor}
}

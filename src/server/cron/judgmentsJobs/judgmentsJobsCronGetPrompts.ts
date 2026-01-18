import {and, eq, sql} from 'drizzle-orm'

import * as schema from '../../../db/schema.ts'
import {getUnassessedPairsFromClickHouse} from '../../../services/clickhouse/unassessedArticlesClickHouse.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {clearJobCursor, getJobCursor, setJobCursor} from './jobCursorStore.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]}

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
      .where(
        and(
          eq(schema.projectPrompts.projectId, projectId),
          eq(schema.projectPrompts.enabled, true),
          eq(schema.projectPrompts.archived, false),
        ),
      ),
  ])

  const [project] = projectResult

  if (!project) {
    return {promptEntries: []}
  }

  if (project.archived) {
    return {promptEntries: []}
  }

  if (!enabledPromptCount[0] || enabledPromptCount[0].count === 0) {
    return {promptEntries: []}
  }

  const cursor = getJobCursor(jobId)
  const result = await getUnassessedPairsFromClickHouse({projectId, jobId, numberOfPromptsToGet, cursor})

  if (result.nextCursor) {
    setJobCursor(jobId, result.nextCursor)
  } else if (cursor) {
    clearJobCursor(jobId)
  }

  return {promptEntries: result.promptEntries}
}

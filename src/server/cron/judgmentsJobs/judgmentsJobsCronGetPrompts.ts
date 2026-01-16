import {and, eq, sql} from 'drizzle-orm'

import * as schema from '../../../db/schema.ts'
import {getUnassessedPairsFromClickHouse} from '../../../services/clickhouse/unassessedArticlesClickHouse.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]}

/**
 * Gets prompts (article × prompt pairs) that need to be judged for a project.
 *
 * Uses ClickHouse to find unassessed pairs (articles without judgments for all prompts).
 * Note: Does NOT check judgments_jobs_prompts queue - caller must use onConflictDoNothing.
 */
export const judgmentsJobsCronGetPrompts = async (
  projectId: string,
  _jobId: string,
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

  return await getUnassessedPairsFromClickHouse({projectId, jobId: _jobId, numberOfPromptsToGet})
}

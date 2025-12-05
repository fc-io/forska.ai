import {and, eq, gte, lte, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]}

/**
 * Gets prompts (article × prompt pairs) that need to be judged for a project.
 * Each entry represents a single prompt that needs to be processed for a specific article.
 */
const getQueryConditions = ({jobId, project}: {jobId: string; project: typeof schema.projects.$inferSelect}) => {
  const conditions = []

  // Exclude article+prompt pairs already claimed/processed by this job
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${schema.judgmentsJobsPrompts} jjp
      WHERE jjp."article_id" = ${schema.articles.id}
      AND jjp."prompt_id" = ${schema.projectPrompts.promptId}
      AND jjp."job_id" = ${jobId}
    )`,
  )

  // Filter by project date range (based on articleCreatedAt for consistency)
  if (project.dateFrom) {
    conditions.push(gte(schema.articles.articleCreatedAt, project.dateFrom))
  }

  if (project.dateTo) {
    conditions.push(lte(schema.articles.articleCreatedAt, project.dateTo))
  }

  // Only get prompts that haven't been judged yet for this article with this model
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${schema.judgments} j
      WHERE j."article_id" = ${schema.articles.id}
      AND j."prompt_id" = ${schema.projectPrompts.promptId}
      AND j."model_id" = ${project.modelId}
    )`,
  )

  // Restrict to articles that belong to any of the project's import routes (via project_route_link)
  // OR articles that are directly linked to the project via project_articles
  conditions.push(
    sql`(
      EXISTS (
        SELECT 1
        FROM ${schema.articleRouteLink} arl
        JOIN ${schema.projectRouteLink} prl ON prl."import_route_id" = arl."import_route_id"
        WHERE arl."article_id" = ${schema.articles.id}
        AND prl."project_id" = ${project.id}
      )
      OR EXISTS (
        SELECT 1
        FROM ${schema.projectArticles} pa
        WHERE pa."article_id" = ${schema.articles.id}
        AND pa."project_id" = ${project.id}
      )
    )`,
  )

  return conditions
}

const getPromptsToQueue = async ({
  db,
  jobId,
  project,
  numberOfPromptsToGet,
}: {
  db: PostgresJsDatabase<typeof schema>
  jobId: string
  project: typeof schema.projects.$inferSelect
  numberOfPromptsToGet: number
}): Promise<QueuePromptsResult> => {
  const queryConditions = getQueryConditions({jobId, project})

  // Cross join articles with project prompts to get all article×prompt pairs that need judging
  const query = db
    .select({articleId: schema.articles.id, promptId: schema.projectPrompts.promptId})
    .from(schema.articles)
    .innerJoin(
      schema.projectPrompts,
      and(eq(schema.projectPrompts.projectId, project.id), eq(schema.projectPrompts.enabled, true)),
    )
    .where(queryConditions.length > 0 ? sql`${sql.join(queryConditions, sql` AND `)}` : undefined)
    .orderBy(
      sql`COALESCE(${schema.articles.articleUpdatedAt}, ${schema.articles.articleCreatedAt}, ${schema.articles.createdAt}) DESC, ${schema.articles.id} DESC`,
    )
    .limit(numberOfPromptsToGet)

  // Use 'pp' alias to refer to project_prompts in the query conditions
  const promptEntries = await query

  return {promptEntries}
}

export const judgmentsJobsCronGetPrompts = async (
  projectId: string,
  jobId: string,
  numberOfPromptsToGet: number,
): Promise<QueuePromptsResult> => {
  const db = getDatabase()

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)

  if (!project) {
    return {promptEntries: []}
  }

  // Check if project has any enabled prompts
  const enabledPromptCount = await db
    .select({count: sql<number>`count(*)`})
    .from(schema.projectPrompts)
    .where(and(eq(schema.projectPrompts.projectId, projectId), eq(schema.projectPrompts.enabled, true)))

  if (!enabledPromptCount[0] || enabledPromptCount[0].count === 0) {
    return {promptEntries: []}
  }

  return await getPromptsToQueue({db, jobId, project, numberOfPromptsToGet})
}

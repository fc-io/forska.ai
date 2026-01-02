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
const getQueryConditions = ({
  jobId,
  project,
  hasImportRoutes,
}: {
  jobId: string
  project: typeof schema.projects.$inferSelect
  hasImportRoutes: boolean
}) => {
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
      AND j."is_answered" = true
    )`,
  )

  // Restrict to articles that belong to any of the project's import routes (via project_route_link)
  // OR articles that are directly linked to the project via project_articles
  // Optimization: If hasImportRoutes is false, we use an innerJoin in the main query instead, so we skip this condition.
  if (hasImportRoutes) {
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
  }

  return conditions
}

const getPromptsToQueue = async ({
  db,
  jobId,
  project,
  numberOfPromptsToGet,
  hasImportRoutes,
}: {
  db: PostgresJsDatabase<typeof schema>
  jobId: string
  project: typeof schema.projects.$inferSelect
  numberOfPromptsToGet: number
  hasImportRoutes: boolean
}): Promise<QueuePromptsResult> => {
  const queryConditions = getQueryConditions({jobId, project, hasImportRoutes})

  // Cross join articles with project prompts to get all article×prompt pairs that need judging
  // We use detailed query construction to safely cast types when optimizing with conditional joins
  let initialQuery = db
    .select({articleId: schema.articles.id, promptId: schema.projectPrompts.promptId})
    .from(schema.articles)
    .$dynamic()

  // Optimization: If the project has NO import routes, we can strictly restrict to project_articles
  // using an INNER JOIN. This is much faster than the OR EXISTS check for large article sets.
  if (!hasImportRoutes) {
    initialQuery = initialQuery.innerJoin(
      schema.projectArticles,
      and(eq(schema.projectArticles.articleId, schema.articles.id), eq(schema.projectArticles.projectId, project.id)),
    )
  }

  const query = initialQuery
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
  // console.log('6')
  return {promptEntries}
}

export const judgmentsJobsCronGetPrompts = async (
  projectId: string,
  jobId: string,
  numberOfPromptsToGet: number,
): Promise<QueuePromptsResult> => {
  const db = getDatabase()
  // console.log('start getting prompts for project', projectId)
  // Run project fetch and enabled prompt count in parallel
  const [projectResult, enabledPromptCount, routeLinksCount] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1),
    db
      .select({count: sql<number>`count(*)`})
      .from(schema.projectPrompts)
      .where(and(eq(schema.projectPrompts.projectId, projectId), eq(schema.projectPrompts.enabled, true))),
    db
      .select({count: sql<number>`count(*)`})
      .from(schema.projectRouteLink)
      .where(eq(schema.projectRouteLink.projectId, projectId)),
  ])

  // console.log('got project and enabled prompt count')
  const [project] = projectResult

  // console.log('1')
  if (!project) {
    return {promptEntries: []}
  }
  // console.log('2')
  // Skip archived projects
  if (project.archived) {
    return {promptEntries: []}
  }
  // console.log('3')
  if (!enabledPromptCount[0] || enabledPromptCount[0].count === 0) {
    return {promptEntries: []}
  }
  // console.log('4')

  const hasImportRoutes = routeLinksCount[0] ? routeLinksCount[0].count > 0 : false

  return await getPromptsToQueue({db, jobId, project, numberOfPromptsToGet, hasImportRoutes})
}

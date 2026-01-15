import {and, eq, gte, lte, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export type PromptQueueEntry = {articleId: string; promptId: string}

export type QueuePromptsResult = {promptEntries: PromptQueueEntry[]}

const getScopedArticles = (db: PostgresJsDatabase<typeof schema>, projectId: string) => {
  const scopedProjectArticles = db
    .select({articleId: schema.projectArticles.articleId})
    .from(schema.projectArticles)
    .where(eq(schema.projectArticles.projectId, projectId))

  const scopedImportRouteArticles = db
    .select({articleId: schema.articleRouteLink.articleId})
    .from(schema.projectRouteLink)
    .innerJoin(
      schema.articleRouteLink,
      eq(schema.articleRouteLink.importRouteId, schema.projectRouteLink.importRouteId),
    )
    .where(eq(schema.projectRouteLink.projectId, projectId))

  const scopedLegacyImportRouteArticles = db
    .select({articleId: schema.articles.id})
    .from(schema.projectRouteLink)
    .innerJoin(schema.importRoute, eq(schema.projectRouteLink.importRouteId, schema.importRoute.id))
    .innerJoin(schema.articles, eq(schema.articles.importRoute, schema.importRoute.route))
    .where(eq(schema.projectRouteLink.projectId, projectId))

  return scopedProjectArticles
    .union(scopedImportRouteArticles)
    .union(scopedLegacyImportRouteArticles)
    .as('scoped_articles')
}

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

  // Only get prompts that haven't been judged yet for this article with this model AND content settings
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${schema.judgments} j
      WHERE j."article_id" = ${schema.articles.id}
      AND j."prompt_id" = ${schema.projectPrompts.promptId}
      AND j."model_id" = ${project.modelId}
      AND j."use_title" = ${project.useTitle}
      AND j."use_abstract" = ${project.useAbstract}
      AND j."use_fulltext" = ${project.useFulltext}
      AND j."use_fulltext_no_images" = ${project.useFulltextNoImages}
      AND j."is_answered" = true
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
  const scopedArticles = getScopedArticles(db, project.id)
  const queryConditions = getQueryConditions({jobId, project})

  const query = db
    .select({articleId: schema.articles.id, promptId: schema.projectPrompts.promptId})
    .from(scopedArticles)
    .innerJoin(schema.articles, eq(scopedArticles.articleId, schema.articles.id))
    .innerJoin(
      schema.projectPrompts,
      and(eq(schema.projectPrompts.projectId, project.id), eq(schema.projectPrompts.enabled, true)),
    )
    .where(queryConditions.length > 0 ? sql`${sql.join(queryConditions, sql` AND `)}` : undefined)
    .orderBy(
      sql`COALESCE(${schema.articles.articleUpdatedAt}, ${schema.articles.articleCreatedAt}, ${schema.articles.createdAt}) DESC, ${schema.articles.id} DESC`,
    )
    .limit(numberOfPromptsToGet)

  const promptEntries = await query
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
  const [projectResult, enabledPromptCount] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1),
    db
      .select({count: sql<number>`count(*)`})
      .from(schema.projectPrompts)
      .where(and(eq(schema.projectPrompts.projectId, projectId), eq(schema.projectPrompts.enabled, true))),
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

  return await getPromptsToQueue({db, jobId, project, numberOfPromptsToGet})
}

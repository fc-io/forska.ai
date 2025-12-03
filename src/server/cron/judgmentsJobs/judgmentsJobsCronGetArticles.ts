import {and, eq, gte, lte, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export type ArticleProcessingData = {
  articlesToJudgeIds: string[]
  articlesToJudge: (typeof schema.articles.$inferSelect)[]
  projectPrompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    order: number | null
    type: string | null
  }>
  isSentToLLM?: boolean
  jobId?: string
}

const getQueryConditions = ({jobId, project}: {jobId: string; project: typeof schema.projects.$inferSelect}) => {
  const conditions = []

  // Exclude articles already claimed/processed by this job without expanding large NOT IN lists
  conditions.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${schema.judgmentsJobsArticles} jja
      WHERE jja."article_id" = ${schema.articles.id}
      AND jja."job_id" = ${jobId}
    )`,
  )

  // Filter by project date range (based on articleCreatedAt for consistency)
  if (project.dateFrom) {
    conditions.push(gte(schema.articles.articleCreatedAt, project.dateFrom))
  }

  if (project.dateTo) {
    conditions.push(lte(schema.articles.articleCreatedAt, project.dateTo))
  }

  // Use EXISTS to find articles that haven't been judged by ALL prompts in this project
  // This checks if there's at least one prompt in the project that doesn't have a judgment for the article
  // IMPORTANT: Differentiate by model; require that any existing judgment also matches the project's model_id
  conditions.push(
    sql`EXISTS (
      SELECT 1 FROM ${schema.projectPrompts} pp
      WHERE pp."project_id" = ${project.id}
      AND pp."enabled" = true
      AND NOT EXISTS (
        SELECT 1 FROM ${schema.judgments} j
        WHERE j."article_id" = ${schema.articles.id}
        AND j."prompt_id" = pp."prompt_id"
        AND j."model_id" = ${project.modelId}
      )
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

const getArticleIdsToJudge = async ({
  db,
  jobId,
  project,
  projectPrompts,
  numberOfArticlesToGet,
}: {
  db: PostgresJsDatabase<typeof schema>
  jobId: string
  project: typeof schema.projects.$inferSelect
  projectPrompts: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    order: number | null
    type: string | null
  }>
  numberOfArticlesToGet: number
}): Promise<ArticleProcessingData> => {
  const queryConditions = getQueryConditions({jobId, project})

  const query = db
    .select()
    .from(schema.articles)
    .where(queryConditions.length > 0 ? sql`${sql.join(queryConditions, sql` AND `)}` : undefined)
    .orderBy(
      sql`COALESCE(${schema.articles.articleUpdatedAt}, ${schema.articles.articleCreatedAt}, ${schema.articles.createdAt}) DESC, ${schema.articles.id} DESC`,
    )
    .limit(numberOfArticlesToGet)

  const articlesToJudge = await query

  return {
    articlesToJudgeIds: articlesToJudge.map((article) => {
      return article.id
    }),
    articlesToJudge,
    projectPrompts,
  }
}

export const judgmentsJobsCronGetArticles = async (
  projectId: string,
  jobId: string,
  numberOfArticlesToGet: number,
): Promise<ArticleProcessingData> => {
  const db = getDatabase()

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  const projectPrompts = await db
    .select({
      id: schema.prompts.id,
      originalText: schema.prompts.originalText,
      promptHeading: schema.prompts.promptHeading,
      order: schema.projectPrompts.order,
      type: schema.prompts.type,
    })
    .from(schema.projectPrompts)
    .innerJoin(schema.prompts, eq(schema.projectPrompts.promptId, schema.prompts.id))
    .where(and(eq(schema.projectPrompts.projectId, projectId), eq(schema.projectPrompts.enabled, true)))
    .orderBy(schema.projectPrompts.order)

  return !project || projectPrompts.length === 0
    ? {articlesToJudgeIds: [], articlesToJudge: [], projectPrompts: []}
    : await getArticleIdsToJudge({db, jobId, project, projectPrompts, numberOfArticlesToGet})
}

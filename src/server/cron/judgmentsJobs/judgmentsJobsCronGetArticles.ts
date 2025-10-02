import {desc, eq, gte, lte, notInArray, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export type ArticleProcessingData = {
  articlesToJudgeIds: string[]
  articlesToJudge: (typeof schema.articles.$inferSelect)[]
  projectPrompts: (typeof schema.prompts.$inferSelect)[]
  isSentToLLM?: boolean
  jobId?: string
}

const getPromptIds = (projectPrompts: (typeof schema.prompts.$inferSelect)[]) => {
  return projectPrompts.map((p) => {
    return p.id
  })
}

const getQueryConditions = ({
  articlesAlreadyProccessing,
  promptIds,
  project,
}: {
  articlesAlreadyProccessing: string[]
  promptIds: string[]
  project: typeof schema.projects.$inferSelect
}) => {
  const conditions = []

  // Exclude articles already being processed
  if (articlesAlreadyProccessing.length > 0) {
    conditions.push(notInArray(schema.articles.id, articlesAlreadyProccessing))
  }

  // Filter by project date range
  if (project.dateFrom) {
    conditions.push(gte(schema.articles.articleUpdatedAt, project.dateFrom))
  }

  if (project.dateTo) {
    conditions.push(lte(schema.articles.articleUpdatedAt, project.dateTo))
  }

  // Use EXISTS to find articles that haven't been judged by ALL prompts
  // This checks if there's at least one prompt that doesn't have a judgment for the article
  conditions.push(
    sql`EXISTS (
      SELECT 1 FROM ${schema.prompts} p
      WHERE p.id = ANY(ARRAY[${sql.join(
        promptIds.map((id) => {
          return sql`${id}::uuid`
        }),
        sql`,`,
      )}])
      AND NOT EXISTS (
        SELECT 1 FROM ${schema.judgments} j
        WHERE j."article_id" = ${schema.articles.id}
        AND j."prompt_id" = p.id
      )
    )`,
  )

  return conditions
}

const getArticleIdsToJudge = async ({
  db,
  project,
  projectPrompts,
  numberOfArticlesToGet,
  articlesAlreadyProccessing,
}: {
  db: PostgresJsDatabase<typeof schema>
  project: typeof schema.projects.$inferSelect
  projectPrompts: (typeof schema.prompts.$inferSelect)[]
  numberOfArticlesToGet: number
  articlesAlreadyProccessing: string[]
}): Promise<ArticleProcessingData> => {
  const promptIds = getPromptIds(projectPrompts)
  const queryConditions = getQueryConditions({articlesAlreadyProccessing, promptIds, project})

  const query = db
    .select()
    .from(schema.articles)
    .where(queryConditions.length > 0 ? sql`${sql.join(queryConditions, sql` AND `)}` : undefined)
    .orderBy(desc(schema.articles.articleUpdatedAt), desc(schema.articles.id))
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
  numberOfArticlesToGet: number,
  articlesAlreadyProccessing: string[] = [],
): Promise<ArticleProcessingData> => {
  const db = getDatabase()

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  const projectPrompts = await db.select().from(schema.prompts).where(eq(schema.prompts.projectId, projectId))

  // No project, return nothing.
  // No prompts, return nothing cause there is no idea to judge when there are no prompts.
  return !project || projectPrompts.length === 0
    ? {articlesToJudgeIds: [], articlesToJudge: [], projectPrompts: []}
    : await getArticleIdsToJudge({db, project, projectPrompts, numberOfArticlesToGet, articlesAlreadyProccessing})
}

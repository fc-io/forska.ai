import {desc, eq, notInArray, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

const getPromptIds = (projectPrompts: (typeof schema.prompts.$inferSelect)[]) => {
  return projectPrompts.map((p) => {
    return p.id
  })
}

const getQueryConditions = ({
  articlesAlreadyProccessing,
  promptIds,
}: {
  articlesAlreadyProccessing: string[]
  promptIds: string[]
}) => {
  const conditions = []

  // Exclude articles already being processed
  if (articlesAlreadyProccessing.length > 0) {
    conditions.push(notInArray(schema.articles.id, articlesAlreadyProccessing))
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
  projectPrompts,
  numberOfArticlesToGet,
  articlesAlreadyProccessing,
}: {
  db: PostgresJsDatabase<typeof schema>
  projectPrompts: (typeof schema.prompts.$inferSelect)[]
  numberOfArticlesToGet: number
  articlesAlreadyProccessing: string[]
}) => {
  const promptIds = getPromptIds(projectPrompts)
  console.log('promptIds length', promptIds.length)
  console.log('articlesAlreadyProccessing length', articlesAlreadyProccessing.length)
  const queryConditions = getQueryConditions({articlesAlreadyProccessing, promptIds})

  const query = db
    .select()
    .from(schema.articles)
    .where(queryConditions.length > 0 ? sql`${sql.join(queryConditions, sql` AND `)}` : undefined)
    .orderBy(desc(schema.articles.articleUpdatedAt), desc(schema.articles.id))
    .limit(numberOfArticlesToGet)

  const articlesToJudge = await query

  console.log('articlesToJudge length', articlesToJudge.length)

  return articlesToJudge.map((article) => {
    return article.id
  })
}

export const judgmentsJobsCronGetArticles = async (
  projectId: string,
  numberOfArticlesToGet: number,
  articlesAlreadyProccessing: string[] = [],
) => {
  const db = getDatabase()

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  const projectPrompts = await db.select().from(schema.prompts).where(eq(schema.prompts.projectId, projectId))

  // No project, return nothing.
  // No prompts, return nothing cause there is no idea to judge when there are no prompts.
  return !project || projectPrompts.length === 0
    ? []
    : await getArticleIdsToJudge({db, projectPrompts, numberOfArticlesToGet, articlesAlreadyProccessing})
}

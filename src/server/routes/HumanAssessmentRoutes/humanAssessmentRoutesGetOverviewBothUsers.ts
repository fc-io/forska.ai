import {and, eq, sql} from 'drizzle-orm'
import type {Context} from 'elysia'

import {user} from '../../../../auth-schema.ts'
import {judgments, judgmentsHuman, projectPrompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesGetOverviewBothUsers = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const db = getDatabase()

  const bothPerUser = await db
    .select({
      userId: judgmentsHuman.user,
      userName: user.name,
      email: user.email,
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
    })
    .from(judgmentsHuman)
    .innerJoin(user, eq(user.id, judgmentsHuman.user))
    .where(
      and(
        // Human: user has answered all prompts linked to the project for the article
        sql`EXISTS (
            SELECT 1
            FROM ${judgmentsHuman} jh2
            WHERE jh2."project_id" = ${judgmentsHuman.projectId}
              AND jh2."article_id" = ${judgmentsHuman.articleId}
              AND jh2."user" = ${judgmentsHuman.user}
              AND jh2."is_answered" = true
            GROUP BY jh2."project_id", jh2."article_id", jh2."user"
            HAVING COUNT(DISTINCT jh2."prompt_id") = (
              SELECT COUNT(*) FROM ${projectPrompts} pp WHERE pp."project_id" = jh2."project_id"
            )
          )`,
        // LLM: article has judgments for all prompts linked to the project
        sql`EXISTS (
            SELECT 1
            FROM ${judgments} j
            INNER JOIN ${projectPrompts} pp2 ON pp2."prompt_id" = j."prompt_id" AND pp2."project_id" = ${judgmentsHuman.projectId}
            WHERE j."article_id" = ${judgmentsHuman.articleId}
              AND j."is_answered" = true
            GROUP BY j."article_id"
            HAVING COUNT(DISTINCT j."prompt_id") = (
              SELECT COUNT(*) FROM ${projectPrompts} pp3 WHERE pp3."project_id" = ${judgmentsHuman.projectId}
            )
          )`,
      ),
    )
    .groupBy(judgmentsHuman.user, user.name, user.email)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: bothPerUser}
}

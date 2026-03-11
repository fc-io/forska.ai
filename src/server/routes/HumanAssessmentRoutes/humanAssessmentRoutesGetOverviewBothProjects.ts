import {and, eq, sql} from 'drizzle-orm'
import type {Context} from 'elysia'

import {judgments, judgmentsHuman, projectPrompts, projects} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesGetOverviewBothProjects = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const db = getDatabase()

  const bothPerProject = await db
    .select({
      projectId: judgmentsHuman.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})`,
    })
    .from(judgmentsHuman)
    .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
    .where(
      and(
        sql`EXISTS (
            SELECT 1
            FROM ${judgmentsHuman} jh2
            WHERE jh2."project_id" = ${judgmentsHuman.projectId}
              AND jh2."article_id" = ${judgmentsHuman.articleId}
              AND jh2."is_answered" = true
            GROUP BY jh2."project_id", jh2."article_id"
            HAVING COUNT(DISTINCT jh2."prompt_id") = (
              SELECT COUNT(*) FROM ${projectPrompts} pp WHERE pp."project_id" = jh2."project_id"
            )
          )`,
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
    .groupBy(judgmentsHuman.projectId, projects.name)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: bothPerProject}
}

import {and, eq, sql} from 'drizzle-orm'

import {auth} from '../../../auth.ts'
import {judgments, judgmentsHuman, projects, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesGetOverviewBothProjects = async ({request, set}: {request: Request; set: any}) => {
  const session = await auth.api.getSession({headers: request.headers})
  const role = session?.user?.role ?? null
  if (role !== 'admin') {
    set.status = 403
    return {data: null, error: 'Administrator access required'}
  }

  const db = getDatabase()

  const bothPerProject = await db
    .select({
      projectId: judgmentsHuman.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
    })
    .from(judgmentsHuman)
    .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
    .where(
      and(
        // Human fully answered across that project's prompt set (derived from judgments_human associations)
        sql`EXISTS (
            SELECT 1
            FROM ${judgmentsHuman} jh2
            WHERE jh2."project_id" = ${judgmentsHuman.projectId}
              AND jh2."article_id" = ${judgmentsHuman.articleId}
              AND jh2."user" = ${judgmentsHuman.user}
              AND jh2."is_answered" = true
            GROUP BY jh2."project_id", jh2."article_id", jh2."user"
            HAVING COUNT(DISTINCT jh2."prompt_id") = (
              SELECT COUNT(DISTINCT jh3."prompt_id") FROM ${judgmentsHuman} jh3 WHERE jh3."project_id" = jh2."project_id"
            )
          )`,
        // LLM judgments present for all prompts associated to this project (derived from judgments_human prompt set)
        sql`EXISTS (
            SELECT 1
            FROM ${judgments} j
            WHERE j."article_id" = ${judgmentsHuman.articleId}
              AND j."is_answered" = true
              AND j."prompt_id" IN (
                SELECT DISTINCT jh4."prompt_id" FROM ${judgmentsHuman} jh4 WHERE jh4."project_id" = ${judgmentsHuman.projectId}
              )
            GROUP BY j."article_id"
            HAVING COUNT(DISTINCT j."prompt_id") = (
              SELECT COUNT(DISTINCT jh5."prompt_id") FROM ${judgmentsHuman} jh5 WHERE jh5."project_id" = ${judgmentsHuman.projectId}
            )
          )`,
      ),
    )
    .groupBy(judgmentsHuman.projectId, projects.name)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: bothPerProject}
}

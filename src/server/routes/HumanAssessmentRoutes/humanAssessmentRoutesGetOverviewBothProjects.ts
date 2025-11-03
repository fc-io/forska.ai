import {and, eq, sql} from 'drizzle-orm'

import {auth} from '../../../auth.ts'
import {judgments, judgmentsHuman, projects, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesGetOverviewBothProjects = async ({
  request,
  set,
}: {
  request: Request
  set: any
}) => {
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
        sql`EXISTS (
            SELECT 1
            FROM ${judgmentsHuman} jh2
            WHERE jh2."project_id" = ${judgmentsHuman.projectId}
              AND jh2."article_id" = ${judgmentsHuman.articleId}
              AND jh2."user" = ${judgmentsHuman.user}
              AND jh2."answer" IS NOT NULL
            GROUP BY jh2."project_id", jh2."article_id", jh2."user"
            HAVING COUNT(DISTINCT jh2."prompt_id") = (
              SELECT COUNT(*) FROM ${prompts} p WHERE p."project_id" = jh2."project_id"
            )
          )`,
        sql`EXISTS (
            SELECT 1
            FROM ${judgments} j
            INNER JOIN ${prompts} pr ON pr."id" = j."prompt_id"
            WHERE pr."project_id" = ${judgmentsHuman.projectId}
              AND j."article_id" = ${judgmentsHuman.articleId}
            GROUP BY j."article_id"
            HAVING COUNT(DISTINCT j."prompt_id") = (
              SELECT COUNT(*) FROM ${prompts} p2 WHERE p2."project_id" = ${judgmentsHuman.projectId}
            )
          )`,
      ),
    )
    .groupBy(judgmentsHuman.projectId, projects.name)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: bothPerProject}
}


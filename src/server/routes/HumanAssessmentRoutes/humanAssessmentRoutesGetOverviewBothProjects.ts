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
        eq(judgmentsHuman.isAnswered, true),
        sql`EXISTS (
          SELECT 1
          FROM ${judgments} j
          WHERE j."article_id" = ${judgmentsHuman.articleId}
            AND j."prompt_id" = ${judgmentsHuman.promptId}
            AND j."is_answered" = true
        )`,
      ),
    )
    .groupBy(judgmentsHuman.projectId, projects.name)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: bothPerProject}
}

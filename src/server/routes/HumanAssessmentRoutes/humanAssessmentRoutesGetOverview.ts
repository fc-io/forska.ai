import {eq, sql} from 'drizzle-orm'
import type {Context} from 'elysia'

import {judgmentsHuman, projects} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {getLocalUser} from '../../utils/getLocalUser.ts'

export const humanAssessmentRoutesGetOverview = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const db = getDatabase()

  const perProject = await db
    .select({
      projectId: judgmentsHuman.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})`,
    })
    .from(judgmentsHuman)
    .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
    .where(eq(judgmentsHuman.isAnswered, true))
    .groupBy(judgmentsHuman.projectId, projects.name)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  const localUser = await getLocalUser()
  const totalCompleted = perProject.reduce((sum, row) => {
    return sum + Number(row.count ?? 0)
  }, 0)
  const perUser = [{userId: localUser.id, userName: localUser.name, email: localUser.email, count: totalCompleted}]

  return {data: {projects: perProject, users: perUser}}
}

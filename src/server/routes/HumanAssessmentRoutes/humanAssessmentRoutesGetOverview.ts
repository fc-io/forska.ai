import {eq, sql} from 'drizzle-orm'
import type {Context} from 'elysia'

import {user} from '../../../../auth-schema.ts'
import {judgmentsHuman, projects} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

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
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
    })
    .from(judgmentsHuman)
    .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
    .where(eq(judgmentsHuman.isAnswered, true))
    .groupBy(judgmentsHuman.projectId, projects.name)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  const perUser = await db
    .select({
      userId: judgmentsHuman.user,
      userName: user.name,
      email: user.email,
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
    })
    .from(judgmentsHuman)
    .innerJoin(user, eq(user.id, judgmentsHuman.user))
    .where(eq(judgmentsHuman.isAnswered, true))
    .groupBy(judgmentsHuman.user, user.name, user.email)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: {projects: perProject, users: perUser}}
}

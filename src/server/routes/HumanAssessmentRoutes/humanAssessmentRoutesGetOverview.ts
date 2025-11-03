import {eq, sql} from 'drizzle-orm'

import {user} from '../../../../auth-schema.ts'
import {auth} from '../../../auth.ts'
import {judgmentsHuman, projects} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesGetOverview = async ({request, set}: {request: Request; set: any}) => {
  const session = await auth.api.getSession({headers: request.headers})
  const role = session?.user?.role ?? null
  if (role !== 'admin') {
    set.status = 403
    return {data: null, error: 'Administrator access required'}
  }

  const db = getDatabase()

  const perProject = await db
    .select({
      projectId: judgmentsHuman.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(DISTINCT ${judgmentsHuman.articleId})::int`,
    })
    .from(judgmentsHuman)
    .innerJoin(projects, eq(projects.id, judgmentsHuman.projectId))
    .where(sql`${judgmentsHuman.answer} IS NOT NULL`)
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
    .where(sql`${judgmentsHuman.answer} IS NOT NULL`)
    .groupBy(judgmentsHuman.user, user.name, user.email)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: {projects: perProject, users: perUser}}
}

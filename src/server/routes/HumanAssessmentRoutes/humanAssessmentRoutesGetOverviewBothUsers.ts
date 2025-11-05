import {and, eq, sql} from 'drizzle-orm'

import {user} from '../../../../auth-schema.ts'
import {auth} from '../../../auth.ts'
import {judgments, judgmentsHuman, prompts} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const humanAssessmentRoutesGetOverviewBothUsers = async ({
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
    .groupBy(judgmentsHuman.user, user.name, user.email)
    .orderBy(sql`COUNT(DISTINCT ${judgmentsHuman.articleId}) DESC`)

  return {data: bothPerUser}
}

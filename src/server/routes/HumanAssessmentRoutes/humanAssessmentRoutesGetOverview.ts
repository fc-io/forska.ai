import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSystemActor} from '../../utils/getSystemActor.ts'

export const humanAssessmentRoutesGetOverview = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const perProject = await getAppDatabaseService().queryJson<{projectId: string; projectName: string; count: number}>(`
    SELECT
      jh.project_id AS projectId,
      p.name AS projectName,
      COUNT(DISTINCT jh.article_id) AS count
    FROM app.judgment_human jh
    INNER JOIN app.project p ON p.id = jh.project_id
    WHERE jh.is_answered = TRUE
    GROUP BY jh.project_id, p.name
    ORDER BY COUNT(DISTINCT jh.article_id) DESC
  `)

  const systemActor = getSystemActor()
  const totalCompleted = perProject.reduce((sum, row) => {
    return sum + Number(row.count ?? 0)
  }, 0)
  const perUser = [
    {userId: systemActor.id, userName: systemActor.name, email: systemActor.email, count: totalCompleted},
  ]

  return {data: {projects: perProject, users: perUser}}
}

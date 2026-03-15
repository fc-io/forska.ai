import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'

export const humanAssessmentRoutesGetOverviewBothProjects = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const bothPerProject = await getAppDatabaseService().queryJson<{
    projectId: string
    projectName: string
    count: number
  }>(`
    SELECT
      jh.project_id AS projectId,
      p.name AS projectName,
      COUNT(DISTINCT jh.article_id) AS count
    FROM app.judgment_human jh
    INNER JOIN app.project p ON p.id = jh.project_id
    WHERE EXISTS (
      SELECT 1
      FROM app.judgment_human jh2
      WHERE jh2.project_id = jh.project_id
        AND jh2.article_id = jh.article_id
        AND jh2.is_answered = TRUE
      GROUP BY jh2.project_id, jh2.article_id
      HAVING COUNT(DISTINCT jh2.prompt_id) = (
        SELECT COUNT(*)
        FROM app.project_prompt pp
        WHERE pp.project_id = jh2.project_id
          AND pp.enabled = TRUE
      )
    )
      AND EXISTS (
        SELECT 1
        FROM app.judgment j
        INNER JOIN app.project_prompt pp2 ON pp2.prompt_id = j.prompt_id AND pp2.project_id = jh.project_id
        WHERE j.article_id = jh.article_id
          AND j.is_answered = TRUE
          AND pp2.enabled = TRUE
        GROUP BY j.article_id
        HAVING COUNT(DISTINCT j.prompt_id) = (
          SELECT COUNT(*)
          FROM app.project_prompt pp3
          WHERE pp3.project_id = jh.project_id
            AND pp3.enabled = TRUE
        )
      )
    GROUP BY jh.project_id, p.name
    ORDER BY COUNT(DISTINCT jh.article_id) DESC
  `)

  return {data: bothPerProject}
}

import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'

export const projectsRoutesGetProjectsWithoutJobs = new Elysia().get('/api/projects-without-jobs', async () => {
  const rows = await getAppDatabaseService().queryJson<{id: string; name: string; description: string | null}>(`
        SELECT p.id AS id, p.name AS name, p.description AS description
        FROM app.project p
        LEFT JOIN app.judgment_job jj ON jj.project_id = p.id
        WHERE jj.id IS NULL
          AND p.delete_pending_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM app.archived_project_delete_tombstone tombstone
            WHERE tombstone.project_id = p.id
              AND tombstone.completed_at IS NULL
          )
        ORDER BY p.created_at DESC
      `)

  return {data: rows}
})

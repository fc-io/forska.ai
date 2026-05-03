import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'

export const archivedProjectAccessErrorMessage = 'Archived projects must be unarchived before use'

type HumanJudgmentMode = 'prompt' | 'summary' | null
type ProjectAccessRow = {archived: boolean; humanJudgmentMode: HumanJudgmentMode; id: string; name: string}

export const getProjectAccess = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<ProjectAccessRow>(`
    SELECT id, name, archived, human_judgment_mode AS humanJudgmentMode
    FROM app.project
    WHERE id = '${escapeSqlString(projectId)}'
      AND delete_pending_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app.archived_project_delete_tombstone tombstone
        WHERE tombstone.project_id = app.project.id
          AND tombstone.completed_at IS NULL
      )
    LIMIT 1
  `)

  return project ?? null
}

export const assertProjectIsActive = async (projectId: string) => {
  const project = await getProjectAccess(projectId)

  if (!project) {
    throw new Error('Project not found')
  }

  if (project.archived) {
    throw new Error(archivedProjectAccessErrorMessage)
  }

  return project
}

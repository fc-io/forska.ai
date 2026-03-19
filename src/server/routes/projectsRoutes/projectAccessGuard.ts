import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'

export const archivedProjectAccessErrorMessage = 'Archived projects must be unarchived before use'

type ProjectAccessRow = {id: string; name: string; archived: boolean}

export const getProjectAccess = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<ProjectAccessRow>(`
    SELECT id, name, archived
    FROM app.project
    WHERE id = '${escapeSqlString(projectId)}'
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

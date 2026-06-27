import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {canCurrentServerOwnDuckdb, getCurrentServerDuckdbOwnerUrl} from '../../utils/serverRuntimeRole.ts'
import {duckdbOwnerPrivateApiPrefix} from '../apiRouteClassification.ts'

export const archivedProjectAccessErrorMessage = 'Archived projects must be unarchived before use'

type HumanJudgmentMode = 'prompt' | 'summary' | null
type ProjectAccessRow = {archived: boolean; humanJudgmentMode: HumanJudgmentMode; id: string; name: string}
type ProjectAccessResponse = {data?: ProjectAccessRow | null; error?: unknown}

const projectAccessUnavailableErrorMessage = 'Project access read model is unavailable'

const getProjectAccessFromDuckdbOwner = async (projectId: string): Promise<ProjectAccessRow | null> => {
  const ownerUrl = await getCurrentServerDuckdbOwnerUrl()

  if (ownerUrl === null) {
    throw new Error(projectAccessUnavailableErrorMessage)
  }

  const response = await fetch(
    `${ownerUrl}${duckdbOwnerPrivateApiPrefix}/api/projects/${encodeURIComponent(projectId)}/access`,
    {signal: AbortSignal.timeout(5_000)},
  )
  const body = (await response.json().catch(() => {
    return null
  })) as ProjectAccessResponse | null

  if (response.status === 404 && body?.error === 'Project not found') {
    return null
  }

  if (body?.data === null) {
    return null
  }

  if (!response.ok || body?.error !== undefined || body?.data === undefined) {
    throw new Error(projectAccessUnavailableErrorMessage)
  }

  return body.data
}

const getProjectAccessFromLocalDuckdb = async (projectId: string): Promise<ProjectAccessRow | null> => {
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

export const getProjectAccess = async (projectId: string): Promise<ProjectAccessRow | null> => {
  return canCurrentServerOwnDuckdb()
    ? getProjectAccessFromLocalDuckdb(projectId)
    : getProjectAccessFromDuckdbOwner(projectId)
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

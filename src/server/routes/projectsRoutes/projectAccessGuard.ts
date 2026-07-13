import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'
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

  if (body?.error === 'Project not found') {
    return null
  }

  if (!response.ok || body?.error !== undefined || body?.data === undefined) {
    throw new Error(projectAccessUnavailableErrorMessage)
  }

  if (body.data === null) {
    return null
  }

  return body.data
}

const getProjectAccessFromLocalDuckdb = async (
  projectId: string,
  workloadContext?: DuckdbWorkloadContext,
): Promise<ProjectAccessRow | null> => {
  const [project] = await getAppDatabaseService().queryJson<ProjectAccessRow>(
    `
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
  `,
    workloadContext,
  )

  return project ?? null
}

export const getProjectAccess = async (
  projectId: string,
  workloadContext?: DuckdbWorkloadContext,
): Promise<ProjectAccessRow | null> => {
  return canCurrentServerOwnDuckdb()
    ? getProjectAccessFromLocalDuckdb(projectId, workloadContext)
    : getProjectAccessFromDuckdbOwner(projectId)
}

export const assertProjectIsActive = async (projectId: string, workloadContext?: DuckdbWorkloadContext) => {
  const project = await getProjectAccess(projectId, workloadContext)

  if (!project) {
    throw new Error('Project not found')
  }

  if (project.archived) {
    throw new Error(archivedProjectAccessErrorMessage)
  }

  return project
}

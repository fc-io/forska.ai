import {getAppDatabaseService} from '../../services/appDatabaseService.ts'

export const judgmentsJobsGetRunningJobs = async () => {
  return getAppDatabaseService().queryJson<{
    id: string
    modelName: string | null
    modelProvider: string | null
    projectId: string
  }>(`
    SELECT
      jj.id AS id,
      jj.project_id AS projectId,
      pc.provider_kind AS modelProvider,
      m.remote_model_id AS modelName
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.status = 'running'
      AND p.archived = FALSE
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
  `)
}

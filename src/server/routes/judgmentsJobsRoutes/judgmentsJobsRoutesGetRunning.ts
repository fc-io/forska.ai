import {
  attachProviderBucketSnapshotToRunningJob,
  type RunningJudgmentJob,
} from '../../cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {getApiReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {hasActiveDuckdbExclusiveWork, isDuckdbExclusiveWorkAdmissionError} from '../../utils/duckdbExclusiveWork.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'

const getOwnerBackedRunningJudgmentJobs = async (): Promise<RunningJudgmentJob[]> => {
  if (hasActiveDuckdbExclusiveWork()) {
    return []
  }

  let rows: Array<
    Omit<RunningJudgmentJob, 'providerName'> & {
      providerConnectionUpdatedAt: Date | string | null
      providerName: string | null
    }
  >

  try {
    rows = await getApiReadOnlyAppDatabaseService().queryJson<(typeof rows)[number]>(
      `
    SELECT
      jj.id AS id,
      jj.project_id AS projectId,
      pc.max_inflight_requests AS maxInflightRequests,
      pc.provider_kind AS modelProvider,
      pc.label AS providerName,
      pc.updated_at AS providerConnectionUpdatedAt,
      m.id AS modelId,
      m.remote_model_id AS modelName,
      jj.quarantine_reason AS quarantineReason,
      m.provider_connection_id AS providerConnectionId,
      jj.storage_state AS storageState
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.status = 'running'
      AND jj.storage_state = 'active'
      AND p.archived = FALSE
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
    ORDER BY jj.created_at ASC, jj.id ASC
      `,
      {maxResultRows: 500, routeOrJobKey: 'judgments.runningJobs', workloadClass: 'foreground-diagnostic'},
    )
  } catch (error) {
    if (isDuckdbExclusiveWorkAdmissionError(error)) {
      return []
    }

    throw error
  }

  return rows.map((row) => {
    return attachProviderBucketSnapshotToRunningJob(row, true)
  })
}

export const judgmentsJobsRoutesGetRunning = async ({request}: {request: Request}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      return {data: {jobs: await getOwnerBackedRunningJudgmentJobs()}, error: null}
    },
    request,
  })
}

import * as appQueryHelpers from '../../../services/appQueryHelpers.ts'
import {getApiReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../../services/judgmentJobSqliteHealthProjectionService.ts'
import {canCurrentServerOwnDuckdb} from '../../../utils/serverRuntimeRole.ts'
import {appDatabaseService} from '../adminInvestigateRoutesServices.ts'

type PendingCompletionAckVisibility = {
  available: boolean
  error: string | null
  freshProjectionCount: number
  hasPendingCompletionAck: boolean
  jobCount: number
  latestProjectedAt: string | null
  oldestUnackedCompletionAgeMs: number | null
  pendingCompletionAckCount: number
}
type PendingCompletionAckVisibilityRow = {
  freshProjectionCount: number | null
  hasPendingCompletionAckCount: number | null
  jobCount: number | null
  latestProjectedAt: unknown
  oldestUnackedCompletionAgeMs: number | null
  pendingCompletionAckCount: number | null
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getWorkerDiagnosticsReadDatabase = (): JudgmentJobSqliteHealthProjectionReader => {
  return canCurrentServerOwnDuckdb() ? appDatabaseService : getApiReadOnlyAppDatabaseService()
}

const getIsoDateFromValue = (value: unknown) => {
  return appQueryHelpers.getDateValue(value)?.toISOString() ?? null
}

export const getPendingCompletionAckVisibilityFromSharedState = async (): Promise<PendingCompletionAckVisibility> => {
  try {
    const [row] = await getWorkerDiagnosticsReadDatabase().queryJson<PendingCompletionAckVisibilityRow>(`
      SELECT
        CAST((SELECT COUNT(*) FROM app.judgment_job) AS INTEGER) AS jobCount,
        CAST(SUM(CASE WHEN fresh_until_at > current_timestamp THEN 1 ELSE 0 END) AS INTEGER) AS freshProjectionCount,
        CAST(SUM(
          CASE WHEN fresh_until_at > current_timestamp THEN pending_completion_ack_count ELSE 0 END
        ) AS INTEGER) AS pendingCompletionAckCount,
        CAST(SUM(
          CASE WHEN fresh_until_at > current_timestamp AND has_pending_completion_ack THEN 1 ELSE 0 END
        ) AS INTEGER) AS hasPendingCompletionAckCount,
        MAX(
          CASE WHEN fresh_until_at > current_timestamp THEN oldest_unacked_completion_age_ms ELSE NULL END
        ) AS oldestUnackedCompletionAgeMs,
        MAX(CASE WHEN fresh_until_at > current_timestamp THEN projected_at ELSE NULL END) AS latestProjectedAt
      FROM app.judgment_job_sqlite_health_projection
    `)

    return {
      available: true,
      error: null,
      freshProjectionCount: Number(row?.freshProjectionCount ?? 0),
      hasPendingCompletionAck: Number(row?.hasPendingCompletionAckCount ?? 0) > 0,
      jobCount: Number(row?.jobCount ?? 0),
      latestProjectedAt: getIsoDateFromValue(row?.latestProjectedAt),
      oldestUnackedCompletionAgeMs:
        row?.oldestUnackedCompletionAgeMs == null ? null : Number(row.oldestUnackedCompletionAgeMs),
      pendingCompletionAckCount: Number(row?.pendingCompletionAckCount ?? 0),
    }
  } catch (error) {
    return {
      available: false,
      error: getErrorMessage(error),
      freshProjectionCount: 0,
      hasPendingCompletionAck: false,
      jobCount: 0,
      latestProjectedAt: null,
      oldestUnackedCompletionAgeMs: null,
      pendingCompletionAckCount: 0,
    }
  }
}

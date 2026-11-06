import {
  anthropicRefusalEmptyResponseFailureCode,
  isProviderContentRefusalFailureCode,
} from '../../../providers/providerContentRefusal.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../../services/judgmentJobSqliteHealthProjectionService.ts'
import {type FailedRequestDetailRecord, getFailedRequestDetailRecords} from '../getFailedRequestDetailRecords.ts'

type FailedRequestSummary = {persistedFailedRequests: number; providerRefusalArticles: number; providerRefusals: number}
type ProviderRefusalSummary = Pick<FailedRequestSummary, 'providerRefusalArticles' | 'providerRefusals'>

const getObjectRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const getDiagnosticsStopReasons = (providerDiagnostics: Record<string, unknown> | null): unknown[] => {
  return [
    providerDiagnostics?.stopReason,
    getObjectRecord(providerDiagnostics?.initial)?.stopReason,
    getObjectRecord(providerDiagnostics?.fallback)?.stopReason,
  ]
}

const isLegacyAnthropicEmptyRefusalDetail = ({error, failureCode}: {error: string; failureCode: string}): boolean => {
  return (
    (failureCode === 'anthropic_empty_response' || error.includes('failure_code=anthropic_empty_response'))
    && error.includes('stop_reason=refusal')
  )
}

export const isProviderRefusalDetail = (detail: FailedRequestDetailRecord): boolean => {
  const error = typeof detail.error === 'string' ? detail.error : ''
  const failureCode = typeof detail.failureCode === 'string' ? detail.failureCode : ''
  const stopReasons = getDiagnosticsStopReasons(getObjectRecord(detail.providerDiagnostics))

  return (
    isProviderContentRefusalFailureCode(failureCode)
    || error.includes(`failure_code=${anthropicRefusalEmptyResponseFailureCode}`)
    || stopReasons.includes('refusal')
    || isLegacyAnthropicEmptyRefusalDetail({error, failureCode})
  )
}

const getProviderRefusalSummary = (rows: Array<{failedRequestsDetails: unknown}>): ProviderRefusalSummary => {
  const detailRecords = rows.flatMap((row) => {
    return getFailedRequestDetailRecords(row.failedRequestsDetails)
  })
  const refusalRecords = detailRecords.filter((detail) => {
    return isProviderRefusalDetail(detail)
  })
  const articleIds = new Set(
    refusalRecords.flatMap((detail) => {
      const articleId = typeof detail.articleId === 'string' ? detail.articleId : null
      return articleId ? [articleId] : []
    }),
  )

  return {providerRefusalArticles: articleIds.size, providerRefusals: refusalRecords.length}
}

const getPersistedFailedRequestCountFromLegacyDetails = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<number> => {
  const [row] = await db.queryJson<{persistedFailedRequests: number | string | null}>(`
    SELECT
      SUM(
        CASE
          WHEN json_type(failed_requests_details) = 'ARRAY' THEN json_array_length(failed_requests_details)
          ELSE 0
        END
      ) AS persistedFailedRequests
    FROM app.token_use
    WHERE judgment_job_id = ${getSqlLiteral(jobId)}
      AND has_failed_requests = TRUE
      AND failed_requests IS NULL
  `)

  return Number(row?.persistedFailedRequests ?? 0)
}

const getPersistedFailedRequestCount = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<number> => {
  const [row] = await db.queryJson<{
    persistedFailedRequests: number | string | null
    legacyFailedRequestRows: number | string | null
  }>(`
    SELECT
      SUM(COALESCE(failed_requests, 0)) AS persistedFailedRequests,
      SUM(CASE WHEN failed_requests IS NULL THEN 1 ELSE 0 END) AS legacyFailedRequestRows
    FROM app.token_use
    WHERE judgment_job_id = ${getSqlLiteral(jobId)}
      AND has_failed_requests = TRUE
  `)
  const persistedFailedRequests = Number(row?.persistedFailedRequests ?? 0)
  const legacyFailedRequestRows = Number(row?.legacyFailedRequestRows ?? 0)
  const legacyPersistedFailedRequests =
    legacyFailedRequestRows > 0 ? await getPersistedFailedRequestCountFromLegacyDetails({db, jobId}) : 0

  return persistedFailedRequests + legacyPersistedFailedRequests
}

const getProviderRefusalSummaryFromDatabase = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<ProviderRefusalSummary> => {
  const rows = await db.queryJson<{failedRequestsDetails: unknown}>(`
    WITH failed_rows AS (
      SELECT
        failed_requests_details,
        CAST(failed_requests_details AS VARCHAR) AS detailText
      FROM app.token_use
      WHERE judgment_job_id = ${getSqlLiteral(jobId)}
        AND has_failed_requests = TRUE
    )
    SELECT TO_JSON(failed_requests_details) AS failedRequestsDetails
    FROM failed_rows
    WHERE contains(detailText, ${getSqlLiteral('refusal')})
  `)

  return getProviderRefusalSummary(rows)
}

export const getFailedRequestSummaryFromDatabase = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<FailedRequestSummary> => {
  const [persistedFailedRequests, providerRefusalSummary] = await Promise.all([
    getPersistedFailedRequestCount({db, jobId}),
    getProviderRefusalSummaryFromDatabase({db, jobId}),
  ])

  return {...providerRefusalSummary, persistedFailedRequests}
}

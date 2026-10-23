import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../../services/judgmentJobSqliteHealthProjectionService.ts'
import {type FailedRequestDetailRecord, getFailedRequestDetailRecords} from '../getFailedRequestDetailRecords.ts'

type FailedRequestSummary = {
  anthropicRefusalArticles: number
  anthropicRefusals: number
  persistedFailedRequests: number
}
type AnthropicRefusalSummary = Pick<FailedRequestSummary, 'anthropicRefusalArticles' | 'anthropicRefusals'>

const isAnthropicRefusalDetail = (detail: FailedRequestDetailRecord): boolean => {
  const error = typeof detail.error === 'string' ? detail.error : ''
  const failureCode = typeof detail.failureCode === 'string' ? detail.failureCode : ''
  const providerDiagnostics =
    detail.providerDiagnostics
    && typeof detail.providerDiagnostics === 'object'
    && !Array.isArray(detail.providerDiagnostics)
      ? (detail.providerDiagnostics as Record<string, unknown>)
      : null
  const initialStopReason =
    providerDiagnostics?.initial
    && typeof providerDiagnostics.initial === 'object'
    && !Array.isArray(providerDiagnostics.initial)
      ? (providerDiagnostics.initial as Record<string, unknown>).stopReason
      : null
  const fallbackStopReason =
    providerDiagnostics?.fallback
    && typeof providerDiagnostics.fallback === 'object'
    && !Array.isArray(providerDiagnostics.fallback)
      ? (providerDiagnostics.fallback as Record<string, unknown>).stopReason
      : null

  return (
    failureCode === 'anthropic_refusal_empty_response'
    || error.includes('failure_code=anthropic_refusal_empty_response')
    || ((failureCode === 'anthropic_empty_response' || error.includes('failure_code=anthropic_empty_response'))
      && (error.includes('stop_reason=refusal') || initialStopReason === 'refusal' || fallbackStopReason === 'refusal'))
  )
}

const getAnthropicRefusalSummary = (rows: Array<{failedRequestsDetails: unknown}>) => {
  const detailRecords = rows.flatMap((row) => {
    return getFailedRequestDetailRecords(row.failedRequestsDetails)
  })
  const refusalRecords = detailRecords.filter((detail) => {
    return isAnthropicRefusalDetail(detail)
  })
  const articleIds = new Set(
    refusalRecords.flatMap((detail) => {
      const articleId = typeof detail.articleId === 'string' ? detail.articleId : null
      return articleId ? [articleId] : []
    }),
  )

  return {anthropicRefusalArticles: articleIds.size, anthropicRefusals: refusalRecords.length}
}

const emptyAnthropicRefusalSummary: AnthropicRefusalSummary = {anthropicRefusalArticles: 0, anthropicRefusals: 0}

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

const getAnthropicRefusalSummaryFromDatabase = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<AnthropicRefusalSummary> => {
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
    WHERE contains(detailText, ${getSqlLiteral('anthropic_refusal_empty_response')})
      OR contains(detailText, ${getSqlLiteral('anthropic_empty_response')})
  `)

  return getAnthropicRefusalSummary(rows)
}

const getAnthropicRefusalSummaryForProvider = ({
  db,
  jobId,
  modelProvider,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
  modelProvider: string | null
}): Promise<AnthropicRefusalSummary> => {
  return modelProvider === 'anthropic'
    ? getAnthropicRefusalSummaryFromDatabase({db, jobId})
    : Promise.resolve(emptyAnthropicRefusalSummary)
}

export const getFailedRequestSummaryFromDatabase = async ({
  db,
  jobId,
  modelProvider,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
  modelProvider: string | null
}): Promise<FailedRequestSummary> => {
  const [persistedFailedRequests, anthropicRefusalSummary] = await Promise.all([
    getPersistedFailedRequestCount({db, jobId}),
    getAnthropicRefusalSummaryForProvider({db, jobId, modelProvider}),
  ])

  return {...anthropicRefusalSummary, persistedFailedRequests}
}

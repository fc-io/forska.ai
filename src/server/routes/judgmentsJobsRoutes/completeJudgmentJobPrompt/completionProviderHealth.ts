import {parseConnectionFailureMessage} from '../../../cron/judgmentsJobs/connectionHealth.ts'
import {
  getProviderFailureRetryDelayMs,
  type JudgmentJobProviderHealth,
  recordJudgmentJobProviderFailure,
  recordJudgmentJobProviderSuccess,
} from '../../../services/judgmentJobProviderHealthService.ts'
import {type FailedRequestDetailRecord, getFailedRequestDetailRecords} from '../getFailedRequestDetailRecords.ts'
import {logProviderHealthWriteFailure} from '../logProviderHealthWriteFailure.ts'
import type {JudgmentCompletionBody} from './judgmentCompletionTypes.ts'

type ProviderFailureDetail = {failureCode: string | null; message: string | null}

const getNonEmptyString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getProviderDiagnosticsMessage = (detail: FailedRequestDetailRecord): string | null => {
  const providerDiagnostics = detail.providerDiagnostics

  return providerDiagnostics && typeof providerDiagnostics === 'object' && !Array.isArray(providerDiagnostics)
    ? getNonEmptyString((providerDiagnostics as Record<string, unknown>).message)
    : null
}

const getProviderFailureDetails = (detail: FailedRequestDetailRecord): ProviderFailureDetail[] => {
  const failureCode = getNonEmptyString(detail.failureCode)
  const error = getNonEmptyString(detail.error)

  return failureCode || error ? [{failureCode, message: getProviderDiagnosticsMessage(detail) ?? error}] : []
}

const getLastProviderFailureDetail = (body: JudgmentCompletionBody): ProviderFailureDetail | null => {
  const failureDetails = getFailedRequestDetailRecords(body.tokenUse?.failedRequestsDetails ?? []).flatMap((detail) => {
    return getProviderFailureDetails(detail)
  })

  return failureDetails.at(-1) ?? null
}

const getCompletionConnectionFailure = (message: string | null) => {
  return message ? parseConnectionFailureMessage(message.replace(/^Connection error:\s*/, '')) : null
}

export const recordCompletionProviderFailure = async (
  jobId: string,
  body: JudgmentCompletionBody,
): Promise<JudgmentJobProviderHealth | null> => {
  const failureDetail = getLastProviderFailureDetail(body)
  const connectionFailure = getCompletionConnectionFailure(failureDetail?.message ?? null)

  return failureDetail && connectionFailure?.kind !== 'circuit_open'
    ? recordJudgmentJobProviderFailure({
        connectionFailureKind: connectionFailure?.kind ?? null,
        failureCode: failureDetail.failureCode,
        jobId,
        message: failureDetail.message,
        modelId: body.modelId,
        statusCode: connectionFailure?.statusCode ?? null,
      }).catch((error: unknown) => {
        return logProviderHealthWriteFailure(jobId, error)
      })
    : null
}

export const recordCompletionProviderSuccess = async (jobId: string): Promise<void> => {
  await recordJudgmentJobProviderSuccess({jobId}).catch((error: unknown) => {
    return logProviderHealthWriteFailure(jobId, error)
  })
}

const getProviderHealthRetryAfterMs = (providerHealth: JudgmentJobProviderHealth | null): number | null => {
  return providerHealth ? getProviderFailureRetryDelayMs(providerHealth) : null
}

export const getCompletionRetryAfterMs = (
  body: JudgmentCompletionBody,
  providerHealth: JudgmentJobProviderHealth | null,
): number | null => {
  return body.retryAfterMs ?? getProviderHealthRetryAfterMs(providerHealth)
}

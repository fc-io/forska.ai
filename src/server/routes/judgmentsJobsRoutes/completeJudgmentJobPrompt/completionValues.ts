import {
  type JudgmentRequestAttemptJsonEntry,
  stringifyRequestAttempts,
  withDurableCloseoutRef,
} from '../../../cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'
import type {JudgmentCompletionBody} from './judgmentCompletionTypes.ts'

export const getJudgmentValueRecord = (body: JudgmentCompletionBody): Record<string, unknown> => {
  return body.judgment && typeof body.judgment === 'object' && !Array.isArray(body.judgment)
    ? (body.judgment as Record<string, unknown>)
    : body
}

const getStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

export const getCompletionAnsweredOriginal = (value: unknown): string | null => {
  return Array.isArray(value)
    ? JSON.stringify(getStringArray(value))
    : typeof value === 'string'
      ? value
      : value == null
        ? null
        : JSON.stringify(value)
}

export const getCompletionAnsweredOriginalAsArray = (value: unknown, fallback: unknown): string[] => {
  const explicit = getStringArray(value)

  return explicit.length > 0
    ? explicit
    : Array.isArray(fallback)
      ? getStringArray(fallback)
      : typeof fallback === 'string'
        ? [fallback]
        : []
}

const getCompletionRequestAttempts = (body: JudgmentCompletionBody): JudgmentRequestAttemptJsonEntry[] => {
  return body.tokenUse?.requestAttempts ?? body.requestAttempts ?? []
}

export const getCompletionRequestAttemptsJson = (
  body: JudgmentCompletionBody,
  closeoutKind: JudgmentRequestAttemptJsonEntry['closeoutKind'],
  id?: string | null,
) => {
  const requestAttempts = getCompletionRequestAttempts(body)

  return stringifyRequestAttempts(
    withDurableCloseoutRef({
      closeoutKind,
      ref: {claimId: body.claimId, id: id ?? null, jobId: body.jobId, queueRecordId: body.queueRecordId},
      requestAttempts,
    }),
  )
}

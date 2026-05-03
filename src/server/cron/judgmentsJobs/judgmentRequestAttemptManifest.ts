export const requestAttemptManifestVersion = 0

export type JudgmentRequestAttemptOutcome = 'failure' | 'success' | 'unknown'

export type JudgmentRequestAttemptCloseoutKind =
  | 'completion_ack'
  | 'completion_outbox'
  | 'judgment_outbox'
  | 'owner_completion_body'
  | 'owner_token_use_body'
  | 'pending_token_use'
  | 'token_use'

export type JudgmentRequestAttemptDurableCloseoutRef = {
  id?: string | null
  kind: JudgmentRequestAttemptCloseoutKind
  jobId?: string | null
  claimId?: string | null
  queueRecordId?: string | null
  requestAttemptId?: string | null
}

export type JudgmentRequestAttemptJsonEntry = {
  requestAttemptId: string
  providerKey: string
  articleId?: string | null
  baseURL?: string | null
  claimId?: string | null
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  completionTokens?: number | null
  durableCloseoutRef?: JudgmentRequestAttemptDurableCloseoutRef | null
  error?: string | null
  errorCode?: string | null
  finishedAt?: string | null
  jobId?: string | null
  outcome: JudgmentRequestAttemptOutcome
  promptId?: string | null
  promptIds?: string[]
  promptTokens?: number | null
  providerDiagnostics?: unknown
  queueRecordId?: string | null
  startedAt?: string | null
  totalTokens?: number | null
}

export type JudgmentRequestAttemptRuntimeContext = {requestAttemptId: string; providerKey: string; createdAt: string}

export type JudgmentRequestAttemptLiveContext = JudgmentRequestAttemptRuntimeContext & {
  baseURL: string
  startedAt: string
}

export const stringifyRequestAttempts = (
  requestAttempts: JudgmentRequestAttemptJsonEntry[] | null | undefined,
): string | null => {
  return requestAttempts && requestAttempts.length > 0 ? JSON.stringify(requestAttempts) : null
}

export const parseRequestAttempts = (
  value: JudgmentRequestAttemptJsonEntry[] | string | null | undefined,
): JudgmentRequestAttemptJsonEntry[] => {
  if (Array.isArray(value)) {
    return value
  }

  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown

    return Array.isArray(parsed) ? (parsed as JudgmentRequestAttemptJsonEntry[]) : []
  } catch {
    return []
  }
}

export const withDurableCloseoutRef = ({
  closeoutKind,
  requestAttempts,
  ref,
}: {
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  requestAttempts: JudgmentRequestAttemptJsonEntry[]
  ref: Omit<JudgmentRequestAttemptDurableCloseoutRef, 'kind' | 'requestAttemptId'>
}): JudgmentRequestAttemptJsonEntry[] => {
  return requestAttempts.map((attempt) => {
    return {
      ...attempt,
      closeoutKind,
      durableCloseoutRef: {...ref, kind: closeoutKind, requestAttemptId: attempt.requestAttemptId},
    }
  })
}

import {
  getRequestAttemptLifecycleState,
  isTerminalRequestAttemptLifecycleState,
  type JudgmentRequestAttemptJsonEntry,
  type JudgmentRequestAttemptLifecycleState,
  parseRequestAttempts,
} from './judgmentRequestAttemptManifest.ts'

export type JudgmentPromptLifecycleState =
  | 'claimed'
  | 'closed'
  | 'completed'
  | 'dispatchQueued'
  | 'hasLiveRequest'
  | 'persisting'
  | 'preparing'
  | 'telemetryUnavailable'
  | 'waitingForRequestSlot'
  | 'workerUnavailable'

export const judgmentPromptLifecycleStates = [
  'claimed',
  'dispatchQueued',
  'preparing',
  'waitingForRequestSlot',
  'hasLiveRequest',
  'persisting',
  'completed',
  'closed',
  'telemetryUnavailable',
  'workerUnavailable',
] as const satisfies JudgmentPromptLifecycleState[]

export type JudgmentLifecycleKind = 'prompt' | 'requestAttempt'
export type JudgmentLifecycleState = JudgmentPromptLifecycleState | JudgmentRequestAttemptLifecycleState

export type JudgmentLifecycleTelemetryRecord = {
  closeoutReason?: string | null
  count?: number
  finishedAt?: string | null
  jobId: string
  lifecycleKind: JudgmentLifecycleKind
  lifecycleState: JudgmentLifecycleState
  promptId?: string | null
  providerKey: string
  queueRecordId?: string | null
  requestAttemptId?: string | null
  startedAt?: string | null
  stateStartedAt?: string | null
  updatedAt?: string | null
}

export type JudgmentLifecycleDurationSummary = {
  avgMs: number | null
  maxMs: number | null
  minMs: number | null
  totalMs: number
}

export type JudgmentLifecycleStateSummary = {
  ageMs: JudgmentLifecycleDurationSummary
  count: number
  durationMs: JudgmentLifecycleDurationSummary
  jobId: string
  lifecycleKind: JudgmentLifecycleKind
  lifecycleState: JudgmentLifecycleState
  providerKey: string
  requestAttemptId: string | null
}

export type JudgmentLifecycleTelemetry = {
  attemptSummaries: JudgmentLifecycleStateSummary[]
  records: JudgmentLifecycleTelemetryRecord[]
  summaries: JudgmentLifecycleStateSummary[]
}

export type JudgmentPromptLifecycleInput = {
  acceptedAt?: string | null
  createdAt?: string | null
  isDispatchQueued?: boolean
  isPreparing?: boolean
  noRequestSuccessReason?: string | null
  promptCloseoutReason?: string | null
  promptTerminalState?: 'closed' | 'completed' | null
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | string | null
  sentAt?: string | null
  status?: string | null
  terminalKind?: string | null
  telemetryUnavailable?: boolean
  updatedAt?: string | null
  workerUnavailable?: boolean
  judgedAt?: string | null
}

type PromptLifecycleRecordInput = JudgmentPromptLifecycleInput & {
  jobId: string
  promptId?: string | null
  providerKey: string
  queueRecordId?: string | null
}

const promptStatePrecedence = new Map<JudgmentPromptLifecycleState, number>([
  ['hasLiveRequest', 0],
  ['waitingForRequestSlot', 1],
  ['persisting', 2],
  ['workerUnavailable', 3],
  ['telemetryUnavailable', 4],
  ['preparing', 5],
  ['dispatchQueued', 6],
  ['claimed', 7],
  ['completed', 8],
  ['closed', 9],
])

const terminalPromptKinds = new Set(['closed', 'failed', 'skipped'])

const getPositiveRecordCount = (record: JudgmentLifecycleTelemetryRecord): number => {
  return typeof record.count === 'number' && Number.isFinite(record.count) ? Math.max(0, Math.trunc(record.count)) : 1
}

const getDateMs = (value: unknown): number | null => {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const numericValue = Number(value)
  const parsed = value.trim().length > 0 && Number.isFinite(numericValue) ? numericValue : Date.parse(value)

  return Number.isFinite(parsed) ? parsed : null
}

const getCanonicalTimestamp = (value: unknown): string | null => {
  const ms = getDateMs(value)

  return ms === null ? null : new Date(ms).toISOString()
}

const getNonNegativeDuration = (startedAt: unknown, finishedAt: unknown): number | null => {
  const startedAtMs = getDateMs(startedAt)
  const finishedAtMs = getDateMs(finishedAt)

  return startedAtMs === null || finishedAtMs === null ? null : Math.max(0, finishedAtMs - startedAtMs)
}

const getRecordAgeMs = (record: JudgmentLifecycleTelemetryRecord, nowMs: number): number | null => {
  const stateStartedAtMs = getDateMs(record.stateStartedAt ?? record.startedAt ?? record.updatedAt)

  return stateStartedAtMs === null ? null : Math.max(0, nowMs - stateStartedAtMs)
}

const getRecordDurationMs = (record: JudgmentLifecycleTelemetryRecord): number | null => {
  return getNonNegativeDuration(record.startedAt ?? record.stateStartedAt ?? record.updatedAt, record.finishedAt)
}

const getEmptyDurationSummary = (): JudgmentLifecycleDurationSummary => {
  return {avgMs: null, maxMs: null, minMs: null, totalMs: 0}
}

const summarizeDurations = (values: number[]): JudgmentLifecycleDurationSummary => {
  const nonNullValues = values.filter((value) => {
    return Number.isFinite(value)
  })
  const totalMs = nonNullValues.reduce((sum, value) => {
    return sum + value
  }, 0)

  return nonNullValues.length === 0
    ? getEmptyDurationSummary()
    : {
        avgMs: Math.round(totalMs / nonNullValues.length),
        maxMs: Math.max(...nonNullValues),
        minMs: Math.min(...nonNullValues),
        totalMs,
      }
}

const getSummaryKey = (record: JudgmentLifecycleTelemetryRecord, requestAttemptId: string | null): string => {
  return [record.jobId, record.providerKey, record.lifecycleKind, record.lifecycleState, requestAttemptId ?? ''].join(
    '\n',
  )
}

const getPromptRecordKey = (record: JudgmentLifecycleTelemetryRecord, index: number): string => {
  const durableId = record.queueRecordId ?? record.promptId ?? null

  return durableId
    ? [record.jobId, record.providerKey, durableId].join('\n')
    : [record.jobId, record.providerKey, record.lifecycleState, String(index)].join('\n')
}

const promptRecordPrecedes = (
  left: JudgmentLifecycleTelemetryRecord,
  right: JudgmentLifecycleTelemetryRecord,
): boolean => {
  const leftOrder = promptStatePrecedence.get(left.lifecycleState as JudgmentPromptLifecycleState) ?? 99
  const rightOrder = promptStatePrecedence.get(right.lifecycleState as JudgmentPromptLifecycleState) ?? 99

  return leftOrder < rightOrder
}

const mergePromptLifecycleRecords = (
  records: JudgmentLifecycleTelemetryRecord[],
): JudgmentLifecycleTelemetryRecord[] => {
  const merged = records.reduce((map, record, index) => {
    if (record.lifecycleKind !== 'prompt') {
      return map
    }

    const key = getPromptRecordKey(record, index)
    const current = map.get(key)
    const nextRecord = !current || promptRecordPrecedes(record, current) ? record : current

    map.set(key, nextRecord)

    return map
  }, new Map<string, JudgmentLifecycleTelemetryRecord>())

  return Array.from(merged.values())
}

const normalizeLifecycleRecords = (records: JudgmentLifecycleTelemetryRecord[]): JudgmentLifecycleTelemetryRecord[] => {
  const promptRecords = mergePromptLifecycleRecords(records)
  const requestAttemptRecords = records.filter((record) => {
    return record.lifecycleKind === 'requestAttempt'
  })

  return [...promptRecords, ...requestAttemptRecords].map((record) => {
    return {
      ...record,
      finishedAt: getCanonicalTimestamp(record.finishedAt),
      startedAt: getCanonicalTimestamp(record.startedAt),
      stateStartedAt: getCanonicalTimestamp(record.stateStartedAt ?? record.startedAt ?? record.updatedAt),
      updatedAt: getCanonicalTimestamp(record.updatedAt),
    }
  })
}

const getSummaries = (
  records: JudgmentLifecycleTelemetryRecord[],
  nowMs: number,
  includeRequestAttemptId: boolean,
): JudgmentLifecycleStateSummary[] => {
  const grouped = records.reduce((map, record) => {
    const requestAttemptId =
      includeRequestAttemptId && record.lifecycleKind === 'requestAttempt' ? (record.requestAttemptId ?? null) : null
    const key = getSummaryKey(record, requestAttemptId)
    const current = map.get(key) ?? {ageValues: [], count: 0, durationValues: [], record, requestAttemptId}
    const recordCount = getPositiveRecordCount(record)
    const ageMs = getRecordAgeMs(record, nowMs)
    const durationMs = getRecordDurationMs(record)

    map.set(key, {
      ageValues: ageMs === null ? current.ageValues : [...current.ageValues, ageMs],
      count: current.count + recordCount,
      durationValues: durationMs === null ? current.durationValues : [...current.durationValues, durationMs],
      record: current.record,
      requestAttemptId,
    })

    return map
  }, new Map<string, {ageValues: number[]; count: number; durationValues: number[]; record: JudgmentLifecycleTelemetryRecord; requestAttemptId: string | null}>())

  return Array.from(grouped.values()).map(({ageValues, count, durationValues, record, requestAttemptId}) => {
    return {
      ageMs: summarizeDurations(ageValues),
      count,
      durationMs: summarizeDurations(durationValues),
      jobId: record.jobId,
      lifecycleKind: record.lifecycleKind,
      lifecycleState: record.lifecycleState,
      providerKey: record.providerKey,
      requestAttemptId,
    }
  })
}

export const getJudgmentLifecycleTelemetry = ({
  now = new Date(),
  records,
}: {
  now?: Date
  records: JudgmentLifecycleTelemetryRecord[]
}): JudgmentLifecycleTelemetry => {
  const normalizedRecords = normalizeLifecycleRecords(records)
  const nowMs = now.getTime()

  return {
    attemptSummaries: getSummaries(normalizedRecords, nowMs, true).filter((summary) => {
      return summary.requestAttemptId !== null
    }),
    records: normalizedRecords,
    summaries: getSummaries(normalizedRecords, nowMs, false),
  }
}

export const mergeJudgmentLifecycleTelemetry = (
  telemetry: Array<JudgmentLifecycleTelemetry | null | undefined>,
): JudgmentLifecycleTelemetry | undefined => {
  const records = telemetry.flatMap((entry) => {
    return entry?.records ?? []
  })

  return records.length === 0 ? undefined : getJudgmentLifecycleTelemetry({records})
}

const getRequestAttemptsFromPromptLifecycleInput = (
  input: JudgmentPromptLifecycleInput,
): JudgmentRequestAttemptJsonEntry[] => {
  return parseRequestAttempts(input.requestAttempts)
}

const hasRequestAttemptState = (
  requestAttempts: JudgmentRequestAttemptJsonEntry[],
  state: JudgmentRequestAttemptLifecycleState,
): boolean => {
  return requestAttempts.some((entry) => {
    return getRequestAttemptLifecycleState(entry) === state
  })
}

const getAllRequestAttemptsTerminal = (requestAttempts: JudgmentRequestAttemptJsonEntry[]): boolean => {
  return (
    requestAttempts.length > 0
    && requestAttempts.every((entry) => {
      return isTerminalRequestAttemptLifecycleState(getRequestAttemptLifecycleState(entry))
    })
  )
}

const getPromptTerminalState = (
  input: JudgmentPromptLifecycleInput,
  requestAttempts: JudgmentRequestAttemptJsonEntry[],
): JudgmentPromptLifecycleState | null => {
  const terminalKind = input.terminalKind?.trim() ?? ''
  const status = input.status?.trim() ?? ''
  const hasCompletedAttempt = hasRequestAttemptState(requestAttempts, 'completedRequest')
  const allAttemptsTerminal = getAllRequestAttemptsTerminal(requestAttempts)
  const hasNoRequestSuccess = Boolean(input.noRequestSuccessReason)
  const explicitCompleted = input.promptTerminalState === 'completed'
  const explicitClosed = input.promptTerminalState === 'closed' || Boolean(input.promptCloseoutReason)
  const statusCompleted =
    status === 'judged'
    && !terminalPromptKinds.has(terminalKind)
    && (requestAttempts.length === 0 || (hasCompletedAttempt && allAttemptsTerminal) || hasNoRequestSuccess)
  const statusClosed = status === 'skipped' || (status === 'judged' && terminalPromptKinds.has(terminalKind))

  return explicitCompleted || statusCompleted || hasNoRequestSuccess
    ? 'completed'
    : explicitClosed || statusClosed
      ? 'closed'
      : null
}

export const getDerivedJudgmentPromptLifecycleState = (
  input: JudgmentPromptLifecycleInput,
): JudgmentPromptLifecycleState | null => {
  const requestAttempts = getRequestAttemptsFromPromptLifecycleInput(input)
  const status = input.status?.trim() ?? ''

  if (hasRequestAttemptState(requestAttempts, 'liveRequest')) {
    return 'hasLiveRequest'
  }

  if (hasRequestAttemptState(requestAttempts, 'waitingForRequestSlot')) {
    return 'waitingForRequestSlot'
  }

  if (hasRequestAttemptState(requestAttempts, 'persistingCompletion')) {
    return 'persisting'
  }

  if (input.workerUnavailable || hasRequestAttemptState(requestAttempts, 'workerUnavailable')) {
    return 'workerUnavailable'
  }

  if (input.telemetryUnavailable || hasRequestAttemptState(requestAttempts, 'telemetryUnavailable')) {
    return 'telemetryUnavailable'
  }

  if (input.isPreparing) {
    return 'preparing'
  }

  if (input.isDispatchQueued) {
    return 'dispatchQueued'
  }

  if (status === 'claimed' || status === 'sent') {
    return 'claimed'
  }

  if (status === 'running') {
    return 'workerUnavailable'
  }

  return getPromptTerminalState(input, requestAttempts)
}

const getPromptStateStartedAt = (
  input: JudgmentPromptLifecycleInput,
  state: JudgmentPromptLifecycleState,
): string | null => {
  const requestAttempts = getRequestAttemptsFromPromptLifecycleInput(input)
  const matchingAttempt = requestAttempts.find((entry) => {
    const requestState = getRequestAttemptLifecycleState(entry)

    return (
      (state === 'hasLiveRequest' && requestState === 'liveRequest')
      || (state === 'waitingForRequestSlot' && requestState === 'waitingForRequestSlot')
      || (state === 'persisting' && requestState === 'persistingCompletion')
      || (state === 'workerUnavailable' && requestState === 'workerUnavailable')
      || (state === 'telemetryUnavailable' && requestState === 'telemetryUnavailable')
    )
  })
  const requestAttemptStartedAt =
    matchingAttempt?.stateStartedAt ?? matchingAttempt?.startedAt ?? matchingAttempt?.createdAt

  return (
    requestAttemptStartedAt
    ?? (state === 'completed' || state === 'closed' ? input.judgedAt : null)
    ?? (state === 'preparing' ? input.sentAt : null)
    ?? (state === 'dispatchQueued' ? input.acceptedAt : null)
    ?? input.updatedAt
    ?? input.createdAt
    ?? null
  )
}

export const getJudgmentPromptLifecycleTelemetryRecord = (
  input: PromptLifecycleRecordInput,
): JudgmentLifecycleTelemetryRecord | null => {
  const lifecycleState = getDerivedJudgmentPromptLifecycleState(input)

  return lifecycleState === null
    ? null
    : {
        closeoutReason: input.promptCloseoutReason ?? input.terminalKind ?? input.noRequestSuccessReason ?? null,
        finishedAt:
          lifecycleState === 'completed' || lifecycleState === 'closed' ? (input.judgedAt ?? input.updatedAt) : null,
        jobId: input.jobId,
        lifecycleKind: 'prompt',
        lifecycleState,
        promptId: input.promptId ?? null,
        providerKey: input.providerKey,
        queueRecordId: input.queueRecordId ?? null,
        startedAt: input.createdAt ?? input.acceptedAt ?? input.sentAt ?? null,
        stateStartedAt: getPromptStateStartedAt(input, lifecycleState),
        updatedAt: input.updatedAt ?? input.judgedAt ?? null,
      }
}

export const getRequestAttemptLifecycleTelemetryRecords = ({
  fallbackJobId,
  fallbackProviderKey,
  requestAttempts,
}: {
  fallbackJobId?: string | null
  fallbackProviderKey?: string | null
  requestAttempts: JudgmentRequestAttemptJsonEntry[] | string | null | undefined
}): JudgmentLifecycleTelemetryRecord[] => {
  return parseRequestAttempts(requestAttempts).flatMap((entry) => {
    const jobId = entry.jobId ?? fallbackJobId ?? null
    const providerKey = entry.providerKey ?? fallbackProviderKey ?? null

    return jobId && providerKey
      ? [
          {
            closeoutReason: entry.closeoutReason ?? entry.persistenceSubreason ?? null,
            finishedAt: entry.finishedAt ?? null,
            jobId,
            lifecycleKind: 'requestAttempt' as const,
            lifecycleState: getRequestAttemptLifecycleState(entry),
            promptId: entry.promptId ?? null,
            providerKey,
            queueRecordId: entry.queueRecordId ?? null,
            requestAttemptId: entry.requestAttemptId,
            startedAt: entry.startedAt ?? entry.createdAt ?? null,
            stateStartedAt: entry.stateStartedAt ?? entry.startedAt ?? entry.createdAt ?? null,
            updatedAt: entry.updatedAt ?? entry.finishedAt ?? null,
          },
        ]
      : []
  })
}

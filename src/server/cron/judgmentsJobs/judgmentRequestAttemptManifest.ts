export const requestAttemptManifestVersion = 0

export type JudgmentRequestAttemptOutcome = 'failure' | 'success' | 'unknown'

export type JudgmentRequestAttemptLifecycleState =
  | 'closedRequest'
  | 'completedRequest'
  | 'liveRequest'
  | 'persistingCompletion'
  | 'telemetryUnavailable'
  | 'waitingForRequestSlot'
  | 'workerUnavailable'

export const requestAttemptLifecycleStates = [
  'waitingForRequestSlot',
  'liveRequest',
  'persistingCompletion',
  'completedRequest',
  'closedRequest',
  'telemetryUnavailable',
  'workerUnavailable',
] as const satisfies JudgmentRequestAttemptLifecycleState[]

export type JudgmentRequestAttemptCloseoutKind =
  | 'completion_ack'
  | 'completion_outbox'
  | 'judgment_outbox'
  | 'live_request'
  | 'manifest_repair'
  | 'owner_completion_body'
  | 'owner_token_use_body'
  | 'persistence'
  | 'pending_token_use'
  | 'slot_wait'
  | 'token_use'

export type JudgmentRequestAttemptDurableCloseoutRef = {
  id?: string | null
  kind: JudgmentRequestAttemptCloseoutKind
  jobId?: string | null
  claimId?: string | null
  queueRecordId?: string | null
  requestAttemptId?: string | null
}

export type JudgmentRequestAttemptLateEvidenceConflict = {
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  detectedAt?: string | null
  durableCloseoutRef?: JudgmentRequestAttemptDurableCloseoutRef | null
  lifecycleState: JudgmentRequestAttemptLifecycleState
  outcome: JudgmentRequestAttemptOutcome
  reason: 'lateEvidenceAfterWorkerLostNoDurableResult'
}

export type JudgmentRequestAttemptJsonEntry = {
  requestAttemptId: string
  providerKey: string
  articleId?: string | null
  baseURL?: string | null
  claimId?: string | null
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  closeoutReason?: string | null
  completionTokens?: number | null
  createdAt?: string | null
  durableCloseoutRef?: JudgmentRequestAttemptDurableCloseoutRef | null
  error?: string | null
  errorCode?: string | null
  finishedAt?: string | null
  jobId?: string | null
  lateEvidenceConflict?: JudgmentRequestAttemptLateEvidenceConflict | null
  lifecycleState?: JudgmentRequestAttemptLifecycleState
  outcome: JudgmentRequestAttemptOutcome
  persistenceSubreason?: string | null
  promptId?: string | null
  promptIds?: string[]
  promptTokens?: number | null
  providerDiagnostics?: unknown
  queueRecordId?: string | null
  stateStartedAt?: string | null
  startedAt?: string | null
  totalTokens?: number | null
  updatedAt?: string | null
}

export type JudgmentRequestAttemptRuntimeContext = {requestAttemptId: string; providerKey: string; createdAt: string}

export type JudgmentRequestAttemptLiveContext = JudgmentRequestAttemptRuntimeContext & {
  baseURL: string
  startedAt: string
}

export type JudgmentRequestAttemptManifestOwner =
  | {
      articleId?: string | null
      claimId?: string | null
      jobId: string
      kind: 'queue_prompt'
      promptId?: string | null
      promptIds?: string[]
      queueRecordId: string
    }
  | {
      articleId?: string | null
      claimId: string
      jobId: string
      kind: 'accepted_claim'
      promptId?: string | null
      promptIds?: string[]
      queueRecordId: string
    }

export type JudgmentRequestAttemptManifestSnapshot = {json: string | null; version: number}

export type JudgmentRequestAttemptManifestRepairMarker = {
  createdAt: string
  ownerId: string
  ownerKind: JudgmentRequestAttemptManifestOwner['kind']
  reason: string
  requestAttemptIds: string[]
}

export type JudgmentRequestAttemptManifestMutation = {
  compactRequestAttemptIds?: string[]
  mergeEntries?: JudgmentRequestAttemptJsonEntry[]
}

export type JudgmentRequestAttemptCloseoutProof = {providerKey: string; requestAttemptId: string}

export class JudgmentRequestAttemptManifestCasExhaustedError extends Error {
  ownerId: string
  ownerKind: JudgmentRequestAttemptManifestOwner['kind']
  requestAttemptIds: string[]

  constructor({
    ownerId,
    ownerKind,
    requestAttemptIds,
  }: {
    ownerId: string
    ownerKind: JudgmentRequestAttemptManifestOwner['kind']
    requestAttemptIds: string[]
  }) {
    super(`request attempt manifest CAS exhausted for ${ownerKind}:${ownerId}`)
    this.name = 'JudgmentRequestAttemptManifestCasExhaustedError'
    this.ownerId = ownerId
    this.ownerKind = ownerKind
    this.requestAttemptIds = requestAttemptIds
  }
}

export class JudgmentRequestAttemptInvariantError extends Error {
  requestAttemptId: string
  reason: string

  constructor({reason, requestAttemptId}: {reason: string; requestAttemptId: string}) {
    super(`request attempt invariant failed for ${requestAttemptId}: ${reason}`)
    this.name = 'JudgmentRequestAttemptInvariantError'
    this.requestAttemptId = requestAttemptId
    this.reason = reason
  }
}

const durableCloseoutKinds = new Set<JudgmentRequestAttemptCloseoutKind>([
  'completion_ack',
  'completion_outbox',
  'judgment_outbox',
  'owner_completion_body',
  'owner_token_use_body',
  'pending_token_use',
  'token_use',
])

const requestAttemptManifestCasMaxAttempts = 6
const requestAttemptManifestRepairMarkerLimit = 10
const terminalRequestAttemptStates = new Set<JudgmentRequestAttemptLifecycleState>([
  'closedRequest',
  'completedRequest',
])
const unavailableRequestAttemptStates = new Set<JudgmentRequestAttemptLifecycleState>([
  'telemetryUnavailable',
  'workerUnavailable',
])
const requestAttemptStateOrder = new Map<JudgmentRequestAttemptLifecycleState, number>([
  ['waitingForRequestSlot', 0],
  ['liveRequest', 1],
  ['persistingCompletion', 2],
  ['completedRequest', 3],
  ['closedRequest', 3],
  ['telemetryUnavailable', 4],
  ['workerUnavailable', 4],
])
const requestAttemptTimestampFields = ['createdAt', 'finishedAt', 'startedAt', 'stateStartedAt', 'updatedAt'] as const
const requestAttemptEvidenceTimestampFields = ['createdAt', 'finishedAt', 'startedAt', 'stateStartedAt'] as const
const requestAttemptOwnerFields = ['articleId', 'claimId', 'jobId', 'promptId', 'queueRecordId'] as const
const requestAttemptTokenFields = ['completionTokens', 'promptTokens', 'totalTokens'] as const

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

const getRequestAttemptIdSet = (ids: string[] | null | undefined): Set<string> => {
  return new Set(
    (ids ?? []).filter((id) => {
      return id.trim().length > 0
    }),
  )
}

const isDurableTerminalRequestAttempt = (entry: JudgmentRequestAttemptJsonEntry): boolean => {
  return durableCloseoutKinds.has(entry.closeoutKind) && Boolean(entry.durableCloseoutRef)
}

export const getRequestAttemptLifecycleState = (
  entry: JudgmentRequestAttemptJsonEntry,
): JudgmentRequestAttemptLifecycleState => {
  if (isDurableTerminalRequestAttempt(entry)) {
    return entry.outcome === 'success' ? 'completedRequest' : 'closedRequest'
  }

  if (entry.closeoutKind === 'persistence') {
    return 'persistingCompletion'
  }

  if (entry.outcome === 'failure' && entry.finishedAt) {
    return 'closedRequest'
  }

  if (entry.lifecycleState) {
    return entry.lifecycleState
  }

  if (entry.closeoutKind === 'slot_wait') {
    return 'waitingForRequestSlot'
  }

  if (entry.closeoutKind === 'live_request') {
    return 'liveRequest'
  }

  return 'persistingCompletion'
}

export const isTerminalRequestAttemptLifecycleState = (state: JudgmentRequestAttemptLifecycleState): boolean => {
  return terminalRequestAttemptStates.has(state)
}

export const isDurableRequestAttemptCloseoutKind = (closeoutKind: JudgmentRequestAttemptCloseoutKind): boolean => {
  return durableCloseoutKinds.has(closeoutKind)
}

export const getDurableTerminalRequestAttemptCloseoutProofs = (
  requestAttempts: JudgmentRequestAttemptJsonEntry[],
): JudgmentRequestAttemptCloseoutProof[] => {
  return requestAttempts.flatMap((entry) => {
    const lifecycleState = getRequestAttemptLifecycleState(entry)
    const providerKey = typeof entry.providerKey === 'string' ? entry.providerKey.trim() : ''
    const requestAttemptId = typeof entry.requestAttemptId === 'string' ? entry.requestAttemptId.trim() : ''
    const hasExactCloseout =
      isDurableRequestAttemptCloseoutKind(entry.closeoutKind)
      && isTerminalRequestAttemptLifecycleState(lifecycleState)
      && Boolean(entry.durableCloseoutRef)
      && providerKey.length > 0
      && requestAttemptId.length > 0

    return hasExactCloseout ? [{providerKey, requestAttemptId}] : []
  })
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

const getComparableScalar = (value: unknown): string | null => {
  if (value == null) {
    return null
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value)
  }

  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  if (typeof value === 'symbol') {
    return value.description ?? null
  }

  return JSON.stringify(value) ?? null
}

const getComparableTimestamp = (value: unknown): string | null => {
  const ms = getDateMs(value)

  return ms === null ? getComparableScalar(value) : String(ms)
}

const getCanonicalTimestamp = (value: unknown): string | null => {
  const ms = getDateMs(value)
  const scalar = getComparableScalar(value)

  return ms === null ? scalar : new Date(ms).toISOString()
}

const getLatestCanonicalTimestamp = (left: unknown, right: unknown): string | null => {
  const leftMs = getDateMs(left)
  const rightMs = getDateMs(right)

  if (leftMs !== null && rightMs !== null) {
    return new Date(Math.max(leftMs, rightMs)).toISOString()
  }

  return getCanonicalTimestamp(right) ?? getCanonicalTimestamp(left)
}

const getEntryComparableTimestamp = (
  entry: JudgmentRequestAttemptJsonEntry,
  field: (typeof requestAttemptEvidenceTimestampFields)[number],
): string | null => {
  return getComparableTimestamp(entry[field])
}

const getEntryComparableScalar = (
  entry: JudgmentRequestAttemptJsonEntry,
  field: keyof JudgmentRequestAttemptJsonEntry,
): string | null => {
  return getComparableScalar(entry[field])
}

const getStateStartedAt = (
  entry: JudgmentRequestAttemptJsonEntry,
  state: JudgmentRequestAttemptLifecycleState,
): string | null => {
  const preferredTimestamp =
    state === 'completedRequest' || state === 'closedRequest'
      ? (entry.finishedAt ?? entry.stateStartedAt ?? entry.updatedAt ?? entry.startedAt ?? entry.createdAt)
      : state === 'liveRequest'
        ? (entry.startedAt ?? entry.stateStartedAt ?? entry.createdAt)
        : (entry.stateStartedAt ?? entry.startedAt ?? entry.createdAt)

  return getCanonicalTimestamp(preferredTimestamp)
}

const normalizeRequestAttemptEntry = (entry: JudgmentRequestAttemptJsonEntry): JudgmentRequestAttemptJsonEntry => {
  const lifecycleState = getRequestAttemptLifecycleState(entry)
  const createdAt = getCanonicalTimestamp(entry.createdAt ?? entry.startedAt ?? entry.stateStartedAt)
  const stateStartedAt = getCanonicalTimestamp(entry.stateStartedAt) ?? getStateStartedAt(entry, lifecycleState)
  const updatedAt =
    getCanonicalTimestamp(entry.updatedAt)
    ?? getCanonicalTimestamp(entry.finishedAt)
    ?? stateStartedAt
    ?? createdAt
    ?? null
  const timestamps = requestAttemptTimestampFields.reduce<Partial<JudgmentRequestAttemptJsonEntry>>((fields, field) => {
    const canonical = getCanonicalTimestamp(entry[field])

    return canonical ? {...fields, [field]: canonical} : fields
  }, {})

  return {...entry, ...timestamps, createdAt, lifecycleState, stateStartedAt, updatedAt}
}

const createInvariantError = ({
  reason,
  requestAttemptId,
}: {
  reason: string
  requestAttemptId: string
}): JudgmentRequestAttemptInvariantError => {
  return new JudgmentRequestAttemptInvariantError({reason, requestAttemptId})
}

const assertComparableFieldMatches = ({
  current,
  field,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  field: keyof JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  const currentValue = getEntryComparableScalar(current, field)
  const incomingValue = getEntryComparableScalar(incoming, field)

  if (currentValue !== null && incomingValue !== null && currentValue !== incomingValue) {
    throw createInvariantError({reason: `${String(field)} conflict`, requestAttemptId: current.requestAttemptId})
  }
}

const assertTokenFieldMatches = ({
  current,
  field,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  field: (typeof requestAttemptTokenFields)[number]
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  const currentValue = current[field]
  const incomingValue = incoming[field]

  if (currentValue != null && incomingValue != null && Number(currentValue) !== Number(incomingValue)) {
    throw createInvariantError({reason: `${field} conflict`, requestAttemptId: current.requestAttemptId})
  }
}

const assertTimestampFieldMatches = ({
  current,
  field,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  field: (typeof requestAttemptEvidenceTimestampFields)[number]
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  const currentValue = getEntryComparableTimestamp(current, field)
  const incomingValue = getEntryComparableTimestamp(incoming, field)

  if (currentValue !== null && incomingValue !== null && currentValue !== incomingValue) {
    throw createInvariantError({reason: `${field} conflict`, requestAttemptId: current.requestAttemptId})
  }
}

const assertDurableCloseoutRefMatches = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  const currentRef = current.durableCloseoutRef ? JSON.stringify(current.durableCloseoutRef) : null
  const incomingRef = incoming.durableCloseoutRef ? JSON.stringify(incoming.durableCloseoutRef) : null

  if (currentRef !== null && incomingRef !== null && currentRef !== incomingRef) {
    throw createInvariantError({reason: 'durableCloseoutRef conflict', requestAttemptId: current.requestAttemptId})
  }
}

const assertKnownOutcomeMatches = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  if (current.outcome !== 'unknown' && incoming.outcome !== 'unknown' && current.outcome !== incoming.outcome) {
    throw createInvariantError({reason: 'outcome conflict', requestAttemptId: current.requestAttemptId})
  }
}

const assertPromptIdsMatch = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  const currentPromptIds = current.promptIds && current.promptIds.length > 0 ? JSON.stringify(current.promptIds) : null
  const incomingPromptIds =
    incoming.promptIds && incoming.promptIds.length > 0 ? JSON.stringify(incoming.promptIds) : null

  if (currentPromptIds !== null && incomingPromptIds !== null && currentPromptIds !== incomingPromptIds) {
    throw createInvariantError({reason: 'promptIds conflict', requestAttemptId: current.requestAttemptId})
  }
}

const assertRequestAttemptIdentityMatches = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  assertComparableFieldMatches({current, field: 'providerKey', incoming})
  requestAttemptOwnerFields.forEach((field) => {
    assertComparableFieldMatches({current, field, incoming})
  })
  assertPromptIdsMatch({current, incoming})
  assertKnownOutcomeMatches({current, incoming})
  requestAttemptTokenFields.forEach((field) => {
    assertTokenFieldMatches({current, field, incoming})
  })
  assertDurableCloseoutRefMatches({current, incoming})
}

const assertTerminalTimestampMatches = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): void => {
  requestAttemptEvidenceTimestampFields.forEach((field) => {
    assertTimestampFieldMatches({current, field, incoming})
  })
}

const closeoutKindCanChange = ({
  current,
  currentState,
  incoming,
  incomingState,
}: {
  current: JudgmentRequestAttemptJsonEntry
  currentState: JudgmentRequestAttemptLifecycleState
  incoming: JudgmentRequestAttemptJsonEntry
  incomingState: JudgmentRequestAttemptLifecycleState
}): boolean => {
  const currentOrder = requestAttemptStateOrder.get(currentState) ?? 0
  const incomingOrder = requestAttemptStateOrder.get(incomingState) ?? 0

  return (
    current.closeoutKind === incoming.closeoutKind
    || incomingOrder > currentOrder
    || unavailableRequestAttemptStates.has(currentState)
  )
}

const assertCloseoutKindCanMerge = ({
  current,
  currentState,
  incoming,
  incomingState,
}: {
  current: JudgmentRequestAttemptJsonEntry
  currentState: JudgmentRequestAttemptLifecycleState
  incoming: JudgmentRequestAttemptJsonEntry
  incomingState: JudgmentRequestAttemptLifecycleState
}): void => {
  if (!closeoutKindCanChange({current, currentState, incoming, incomingState})) {
    throw createInvariantError({reason: 'closeoutKind conflict', requestAttemptId: current.requestAttemptId})
  }
}

const entryHasLateWorkerLostDurableEvidenceConflict = ({
  current,
  currentState,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  currentState: JudgmentRequestAttemptLifecycleState
  incoming: JudgmentRequestAttemptJsonEntry
}): boolean => {
  return (
    currentState === 'closedRequest'
    && current.closeoutReason === 'workerLostNoDurableResult'
    && isDurableTerminalRequestAttempt(incoming)
  )
}

const getLateEvidenceConflict = (
  incoming: JudgmentRequestAttemptJsonEntry,
): JudgmentRequestAttemptLateEvidenceConflict => {
  return {
    closeoutKind: incoming.closeoutKind,
    detectedAt: incoming.updatedAt ?? incoming.finishedAt ?? incoming.stateStartedAt ?? null,
    durableCloseoutRef: incoming.durableCloseoutRef ?? null,
    lifecycleState: getRequestAttemptLifecycleState(incoming),
    outcome: incoming.outcome,
    reason: 'lateEvidenceAfterWorkerLostNoDurableResult',
  }
}

const getMergedMetadataEntry = ({
  current,
  incoming,
  lifecycleState,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
  lifecycleState: JudgmentRequestAttemptLifecycleState
}): JudgmentRequestAttemptJsonEntry => {
  const merged = {
    ...current,
    ...incoming,
    closeoutKind: incoming.closeoutKind,
    durableCloseoutRef: incoming.durableCloseoutRef ?? current.durableCloseoutRef ?? null,
    lifecycleState,
    outcome: current.outcome === 'unknown' ? incoming.outcome : current.outcome,
    updatedAt: getLatestCanonicalTimestamp(current.updatedAt, incoming.updatedAt),
  }

  return normalizeRequestAttemptEntry(merged)
}

const getTerminalSinkEntry = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): JudgmentRequestAttemptJsonEntry => {
  const currentState = getRequestAttemptLifecycleState(current)
  const incomingState = getRequestAttemptLifecycleState(incoming)

  if (currentState === incomingState) {
    assertCloseoutKindCanMerge({current, currentState, incoming, incomingState})
    assertTerminalTimestampMatches({current, incoming})
    return getMergedMetadataEntry({current, incoming, lifecycleState: currentState})
  }

  if (entryHasLateWorkerLostDurableEvidenceConflict({current, currentState, incoming})) {
    return normalizeRequestAttemptEntry({...current, lateEvidenceConflict: getLateEvidenceConflict(incoming)})
  }

  return current
}

const incomingSupersedesUnavailableState = ({
  currentState,
  incoming,
}: {
  currentState: JudgmentRequestAttemptLifecycleState
  incoming: JudgmentRequestAttemptJsonEntry
}): boolean => {
  return unavailableRequestAttemptStates.has(currentState) && isDurableTerminalRequestAttempt(incoming)
}

const incomingClosesUnavailableState = ({
  currentState,
  incomingState,
}: {
  currentState: JudgmentRequestAttemptLifecycleState
  incomingState: JudgmentRequestAttemptLifecycleState
}): boolean => {
  return unavailableRequestAttemptStates.has(currentState) && incomingState === 'closedRequest'
}

const incomingCanAdvanceState = ({
  currentState,
  incoming,
  incomingState,
}: {
  currentState: JudgmentRequestAttemptLifecycleState
  incoming: JudgmentRequestAttemptJsonEntry
  incomingState: JudgmentRequestAttemptLifecycleState
}): boolean => {
  const currentOrder = requestAttemptStateOrder.get(currentState) ?? 0
  const incomingOrder = requestAttemptStateOrder.get(incomingState) ?? 0

  return (
    incomingState === currentState
    || incomingOrder > currentOrder
    || isDurableTerminalRequestAttempt(incoming)
    || incomingSupersedesUnavailableState({currentState, incoming})
    || incomingClosesUnavailableState({currentState, incomingState})
  )
}

const mergeManifestEntry = ({
  current,
  incoming,
}: {
  current: JudgmentRequestAttemptJsonEntry
  incoming: JudgmentRequestAttemptJsonEntry
}): JudgmentRequestAttemptJsonEntry => {
  const currentState = getRequestAttemptLifecycleState(current)
  const incomingState = getRequestAttemptLifecycleState(incoming)

  assertRequestAttemptIdentityMatches({current, incoming})

  if (isTerminalRequestAttemptLifecycleState(currentState)) {
    return getTerminalSinkEntry({current, incoming})
  }

  if (!incomingCanAdvanceState({currentState, incoming, incomingState})) {
    return current
  }

  assertCloseoutKindCanMerge({current, currentState, incoming, incomingState})

  return getMergedMetadataEntry({current, incoming, lifecycleState: incomingState})
}

const mergeManifestEntriesByRequestAttemptId = (
  current: JudgmentRequestAttemptJsonEntry[],
  incoming: JudgmentRequestAttemptJsonEntry[],
): JudgmentRequestAttemptJsonEntry[] => {
  const mergeEntryIntoMap = (
    map: Map<string, JudgmentRequestAttemptJsonEntry>,
    entry: JudgmentRequestAttemptJsonEntry,
  ): Map<string, JudgmentRequestAttemptJsonEntry> => {
    const normalizedEntry = normalizeRequestAttemptEntry(entry)
    const existing = map.get(normalizedEntry.requestAttemptId)
    const nextEntry = existing ? mergeManifestEntry({current: existing, incoming: normalizedEntry}) : normalizedEntry

    map.set(normalizedEntry.requestAttemptId, nextEntry)

    return map
  }
  const currentMap = current.reduce(mergeEntryIntoMap, new Map<string, JudgmentRequestAttemptJsonEntry>())

  return Array.from(incoming.reduce(mergeEntryIntoMap, currentMap).values())
}

const compactDurableManifestEntries = (
  entries: JudgmentRequestAttemptJsonEntry[],
  requestAttemptIds: string[] | null | undefined,
): JudgmentRequestAttemptJsonEntry[] => {
  const compactIds = getRequestAttemptIdSet(requestAttemptIds)

  return compactIds.size === 0
    ? entries
    : entries.filter((entry) => {
        return !compactIds.has(entry.requestAttemptId) || !isDurableTerminalRequestAttempt(entry)
      })
}

export const mutateRequestAttemptManifestEntries = ({
  currentEntries,
  mutation,
}: {
  currentEntries: JudgmentRequestAttemptJsonEntry[]
  mutation: JudgmentRequestAttemptManifestMutation
}): JudgmentRequestAttemptJsonEntry[] => {
  const mergedEntries = mergeManifestEntriesByRequestAttemptId(currentEntries, mutation.mergeEntries ?? [])

  return compactDurableManifestEntries(mergedEntries, mutation.compactRequestAttemptIds)
}

export const stringifyManifestEntries = (entries: JudgmentRequestAttemptJsonEntry[]): string => {
  return JSON.stringify(entries)
}

export const requestAttemptManifestChanged = (
  currentEntries: JudgmentRequestAttemptJsonEntry[],
  nextEntries: JudgmentRequestAttemptJsonEntry[],
): boolean => {
  return stringifyManifestEntries(currentEntries) !== stringifyManifestEntries(nextEntries)
}

export const getRequestAttemptManifestMutationIds = (mutation: JudgmentRequestAttemptManifestMutation): string[] => {
  return Array.from(
    new Set([
      ...(mutation.mergeEntries ?? []).map((entry) => {
        return entry.requestAttemptId
      }),
      ...(mutation.compactRequestAttemptIds ?? []),
    ]),
  )
}

export const getRequestAttemptManifestOwnerId = (owner: JudgmentRequestAttemptManifestOwner): string => {
  return owner.kind === 'accepted_claim' ? owner.claimId : owner.queueRecordId
}

export const createRequestAttemptManifestRepairMarker = ({
  owner,
  reason,
  requestAttemptIds,
}: {
  owner: JudgmentRequestAttemptManifestOwner
  reason: string
  requestAttemptIds: string[]
}): JudgmentRequestAttemptManifestRepairMarker => {
  return {
    createdAt: new Date().toISOString(),
    ownerId: getRequestAttemptManifestOwnerId(owner),
    ownerKind: owner.kind,
    reason,
    requestAttemptIds,
  }
}

export const parseRequestAttemptManifestRepairMarkers = (
  value: string | null | undefined,
): JudgmentRequestAttemptManifestRepairMarker[] => {
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown

    return Array.isArray(parsed) ? (parsed as JudgmentRequestAttemptManifestRepairMarker[]) : []
  } catch {
    return []
  }
}

export const appendRequestAttemptManifestRepairMarker = ({
  currentJson,
  marker,
}: {
  currentJson: string | null | undefined
  marker: JudgmentRequestAttemptManifestRepairMarker
}): string => {
  return JSON.stringify(
    [...parseRequestAttemptManifestRepairMarkers(currentJson), marker].slice(-requestAttemptManifestRepairMarkerLimit),
  )
}

export const shouldExhaustRequestAttemptManifestCas = (attemptIndex: number): boolean => {
  return attemptIndex >= requestAttemptManifestCasMaxAttempts
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
    return normalizeRequestAttemptEntry({
      ...attempt,
      closeoutKind,
      durableCloseoutRef: {...ref, kind: closeoutKind, requestAttemptId: attempt.requestAttemptId},
      lifecycleState: attempt.outcome === 'success' ? 'completedRequest' : 'closedRequest',
    })
  })
}

export const withRequestAttemptManifestStage = ({
  closeoutKind,
  requestAttempts,
}: {
  closeoutKind: JudgmentRequestAttemptCloseoutKind
  requestAttempts: JudgmentRequestAttemptJsonEntry[]
}): JudgmentRequestAttemptJsonEntry[] => {
  return requestAttempts.map((attempt) => {
    return normalizeRequestAttemptEntry({
      ...attempt,
      closeoutKind,
      durableCloseoutRef: null,
      lifecycleState: closeoutKind === 'persistence' ? 'persistingCompletion' : undefined,
    })
  })
}

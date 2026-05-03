export const requestAttemptManifestVersion = 0

export type JudgmentRequestAttemptOutcome = 'failure' | 'success' | 'unknown'

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

const mergeManifestEntriesByRequestAttemptId = (
  current: JudgmentRequestAttemptJsonEntry[],
  incoming: JudgmentRequestAttemptJsonEntry[],
): JudgmentRequestAttemptJsonEntry[] => {
  const merged = new Map(
    current.map((entry) => {
      return [entry.requestAttemptId, entry] as const
    }),
  )

  incoming.forEach((entry) => {
    const existing = merged.get(entry.requestAttemptId)
    merged.set(entry.requestAttemptId, existing ? {...existing, ...entry} : entry)
  })

  return Array.from(merged.values())
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
    return {
      ...attempt,
      closeoutKind,
      durableCloseoutRef: {...ref, kind: closeoutKind, requestAttemptId: attempt.requestAttemptId},
    }
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
    return {...attempt, closeoutKind, durableCloseoutRef: null}
  })
}

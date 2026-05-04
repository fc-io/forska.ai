import {createHash} from 'node:crypto'

import {duckdbOwnerPrivateApiPrefix} from '../../routes/apiRouteClassification.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  canCurrentServerOwnDuckdb,
  ensureCurrentDuckdbOwnerLease,
  getCurrentServerDuckdbOwnerUrl,
} from '../../utils/serverRuntimeRole.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getNormalizedProviderKeyProvider, getProviderKey} from './providerKey.ts'

type Capacity = {maxInflight: number; maxBurst: number; workerCount: number}

export type ProviderAdmissionLeaseKind = 'probe' | 'request'
export type ProviderAdmissionLeaseClock = {now: () => Date}

export type ProviderBucketSnapshot = {
  maxInflightRequests: number | null
  providerFamily: string
  providerId: string
  providerKey: string
  providerLimit: number
  providerLimitVersion: string
  providerName: string
  providerUsesFamilyDefault: boolean
  resolvedDefaultCapacity: number
}

export type ProviderBucketSnapshotInput = {
  getCodexDefaultMaxInflight?: () => number
  getNonCodexCapacity?: (runningJobCount: number) => Capacity
  maxInflightRequests: number | null
  modelId?: string | null
  modelProvider?: string | null
  providerConnectionId?: string | null
  providerConnectionUpdatedAt?: Date | string | null
  providerName?: string | null
  useOwnerBackedSyntheticProviderId?: boolean
}

export type ProviderAdmissionLeaseAcquireResult =
  | {
      acquired: true
      activeLeaseCount: number
      activeProbeLeaseCount?: number
      alreadyHeld: boolean
      currentSnapshot: ProviderBucketSnapshot
      lease?: ProviderAdmissionLeaseRecord
      providerLimit: number
      providerLimitVersion: string
      staleProviderLimitSnapshot: boolean
    }
  | {
      acquired: false
      activeLeaseCount: number
      activeProbeLeaseCount?: number
      alreadyHeld?: boolean
      currentSnapshot: ProviderBucketSnapshot
      lease?: ProviderAdmissionLeaseRecord
      providerLimit: number
      providerLimitVersion: string
      reason: 'alreadyHeld' | 'capacity' | 'staleProviderLimitSnapshot'
      staleProviderLimitSnapshot: boolean
    }

type ProviderAdmissionLease = {
  acquiredAtMs: number
  endpointAvailabilityKey: string | null
  expiresAtMs: number
  heartbeatAtMs: number
  holderToken: string
  leaseIdentity: string
  leaseKind: ProviderAdmissionLeaseKind
  providerKey: string
  providerLimitVersion: string
}

export type ProviderAdmissionLeaseRecord = {
  acquiredAt: string
  acquiredAtMs: number
  endpointAvailabilityKey: string | null
  expiresAt: string
  expiresAtMs: number
  heartbeatAt: string
  heartbeatAtMs: number
  holderToken: string
  leaseIdentity: string
  leaseKind: ProviderAdmissionLeaseKind
  probeAttemptId: string | null
  providerKey: string
  requestAttemptId: string | null
}

export type ProviderAdmissionLeaseAcquireInput = {
  endpointAvailabilityKey?: string | null
  holderToken: string
  leaseIdentity: string
  leaseKind?: ProviderAdmissionLeaseKind
  nowMs?: number
  probeAttemptId?: string | null
  requestAttemptId?: string | null
  snapshot: ProviderBucketSnapshot
  ttlMs?: number
}

export type ProviderAdmissionLeaseReleaseInput = {holderToken: string; leaseIdentity: string; providerKey: string}

export type ProviderAdmissionLeaseReleaseResult = {released: true} | {released: false; reason: 'missing' | 'notHolder'}

export type ProviderAdmissionLeaseHeartbeatInput = ProviderAdmissionLeaseReleaseInput & {nowMs?: number; ttlMs?: number}

export type ProviderAdmissionLeaseHeartbeatResult =
  | {heartbeat: true; lease: ProviderAdmissionLeaseRecord}
  | {heartbeat: false; reason: 'missing' | 'notHolder'}

export type ProviderAdmissionLeaseExpiryInput = {nowMs?: number; providerKey: string}

export type ProviderAdmissionLeaseExpiryResult = {expiredLeaseCount: number}
export type ProviderAdmissionLeaseTelemetry = {
  providerKey: string
  providerLeasedLiveRequests: number
  providerLeasedProbeCalls: number
  providerProbeOccupancyVersion: string
  sampledAtMs: number
}

export type ProviderAdmissionLeaseHolderWorkerFreshness = 'demoted' | 'fresh' | 'missing' | 'stale'

export type ProviderAdmissionLeaseHolderWorkerDemotion = {
  demotedAtMs?: number | null
  freshness?: ProviderAdmissionLeaseHolderWorkerFreshness
  holderToken: string
  missingSinceMs?: number | null
  observedAtMs?: number | null
  staleSinceMs?: number | null
  state?: ProviderAdmissionLeaseHolderWorkerFreshness
}

export type ProviderAdmissionLeaseTerminalRequestCloseout = {providerKey?: string | null; requestAttemptId: string}

export type ProviderAdmissionLeaseSuspectFreshProof = {
  holderToken?: string | null
  leaseIdentity: string
  leaseKind?: ProviderAdmissionLeaseKind | null
  providerKey: string
}

export type ProviderAdmissionLeaseReconciliationInput = {
  holderGraceMs?: number
  holderWorkerDemotions?: ProviderAdmissionLeaseHolderWorkerDemotion[]
  nowMs?: number
  suspectFreshHolderProofs?: ProviderAdmissionLeaseSuspectFreshProof[]
  suspectFreshProofs?: ProviderAdmissionLeaseSuspectFreshProof[]
  terminalRequestAttemptCloseouts?: ProviderAdmissionLeaseTerminalRequestCloseout[]
}

export type ProviderAdmissionLeaseReconciliationResult = {
  durableRequestCloseoutLeaseCount: number
  expiredLeaseCount: number
  graceHeldLeaseCount: number
  holderDemotionLeaseCount: number
  suspectFreshHolderLeaseCount: number
  suspectFreshProofLeaseCount: number
}

type ProviderAdmissionLeaseIdentityParts = {
  endpointAvailabilityKey: string | null
  leaseKind: ProviderAdmissionLeaseKind
  probeAttemptId: string | null
  requestAttemptId: string | null
}

type ProviderAdmissionLeaseRow = {
  acquiredAt: Date | string
  endpointAvailabilityKey: string | null
  expiresAt: Date | string
  heartbeatAt: Date | string
  holderToken: string
  leaseIdentity: string
  leaseKind: ProviderAdmissionLeaseKind
  probeAttemptId: string | null
  providerKey: string
  requestAttemptId: string | null
}

type DeletedProviderAdmissionLeaseRow = {
  leaseIdentity: string
  leaseKind: ProviderAdmissionLeaseKind
  providerKey: string
}

const currentProviderSnapshots = new Map<string, ProviderBucketSnapshot>()
const providerAdmissionLeases = new Map<string, ProviderAdmissionLease>()
const providerAdmissionLeaseOperationQueues = new Map<string, Promise<void>>()
const providerProbeOccupancyVersionCounters = new Map<string, number>()

export const providerAdmissionLeaseTtlMs = 60_000
export const providerAdmissionLeaseHeartbeatIntervalMs = 15_000
export const providerAdmissionLeaseOwnerApiPath = '/api/provideradmissionleases'
export const providerAdmissionLeaseOwnerApiAliasPath = '/api/provider-admission-leases'

const defaultProviderAdmissionLeaseClock: ProviderAdmissionLeaseClock = {
  now: () => {
    return new Date()
  },
}

const getNormalizedLeaseDurationMs = (value: number): number => {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : providerAdmissionLeaseTtlMs
}

const getNormalizedGraceDurationMs = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : providerAdmissionLeaseTtlMs
}

const getNormalizedTimestampMs = (value: number): number => {
  return Number.isFinite(value) ? Math.trunc(value) : Date.now()
}

const getRequiredLeaseIdentityPart = ({label, value}: {label: string; value: string}): string => {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    throw new Error(`${label} is required for provider admission lease identity`)
  }

  return trimmed
}

export const getProviderAdmissionRequestLeaseIdentity = (requestAttemptId: string): string => {
  return `request:${getRequiredLeaseIdentityPart({label: 'requestAttemptId', value: requestAttemptId})}`
}

export const getProviderAdmissionProbeLeaseIdentity = ({
  endpointAvailabilityKey,
  probeAttemptId,
}: {
  endpointAvailabilityKey: string
  probeAttemptId: string
}): string => {
  const endpointKey = getRequiredLeaseIdentityPart({label: 'endpointAvailabilityKey', value: endpointAvailabilityKey})
  const probeId = getRequiredLeaseIdentityPart({label: 'probeAttemptId', value: probeAttemptId})

  return `probe:${endpointKey}:${probeId}`
}

export const getProviderAdmissionLeaseTiming = ({
  clock = defaultProviderAdmissionLeaseClock,
  ttlMs = providerAdmissionLeaseTtlMs,
}: {clock?: ProviderAdmissionLeaseClock; ttlMs?: number} = {}): {
  acquiredAt: Date
  expiresAt: Date
  heartbeatAt: Date
  heartbeatIntervalMs: number
  ttlMs: number
} => {
  const currentNow = clock.now()
  const normalizedTtlMs = getNormalizedLeaseDurationMs(ttlMs)

  return {
    acquiredAt: new Date(currentNow.getTime()),
    expiresAt: new Date(currentNow.getTime() + normalizedTtlMs),
    heartbeatAt: new Date(currentNow.getTime()),
    heartbeatIntervalMs: Math.min(providerAdmissionLeaseHeartbeatIntervalMs, normalizedTtlMs),
    ttlMs: normalizedTtlMs,
  }
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const trimmed = String(value ?? '').trim()

  return trimmed.length > 0 ? trimmed : null
}

const getStableJsonValue = (value: unknown): string => {
  return Array.isArray(value)
    ? `[${value
        .map((entry) => {
          return getStableJsonValue(entry)
        })
        .join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.keys(value)
          .sort((left, right) => {
            return left.localeCompare(right)
          })
          .map((key) => {
            return `${JSON.stringify(key)}:${getStableJsonValue((value as Record<string, unknown>)[key])}`
          })
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null')
}

const getIsoVersionValue = (value: Date | string | null | undefined): string | null => {
  return value instanceof Date ? value.toISOString() : getTrimmedValue(value)
}

const getProviderLimitVersion = (input: {
  maxInflightRequests: number | null
  providerConnectionUpdatedAt?: Date | string | null
  providerFamily: string
  providerKey: string
  providerLimit: number
  providerName: string
  resolvedDefaultCapacity: number
}): string => {
  return createHash('sha256')
    .update(
      getStableJsonValue({
        maxInflightRequests: input.maxInflightRequests,
        providerConnectionUpdatedAt: getIsoVersionValue(input.providerConnectionUpdatedAt),
        providerFamily: input.providerFamily,
        providerKey: input.providerKey,
        providerLimit: input.providerLimit,
        providerName: input.providerName,
        resolvedDefaultCapacity: input.resolvedDefaultCapacity,
        version: 1,
      }),
    )
    .digest('hex')
}

const getProviderFamilyDefaultCapacity = ({
  getCodexDefaultMaxInflight,
  getNonCodexCapacity,
  providerFamily,
}: {
  getCodexDefaultMaxInflight: () => number
  getNonCodexCapacity: (runningJobCount: number) => Capacity
  providerFamily: string
}): number => {
  return providerFamily === 'codex' ? getCodexDefaultMaxInflight() : getNonCodexCapacity(1).maxInflight
}

export const publishProviderBucketSnapshot = (snapshot: ProviderBucketSnapshot): ProviderBucketSnapshot => {
  currentProviderSnapshots.set(snapshot.providerKey, snapshot)
  return snapshot
}

export const getProviderBucketSnapshot = ({
  getCodexDefaultMaxInflight = getCodexMaxInflight,
  getNonCodexCapacity = getJudgmentsCapacity,
  maxInflightRequests,
  modelId,
  modelProvider,
  providerConnectionId,
  providerConnectionUpdatedAt,
  providerName,
  useOwnerBackedSyntheticProviderId = false,
}: ProviderBucketSnapshotInput): ProviderBucketSnapshot => {
  const providerFamily = getNormalizedProviderKeyProvider(modelProvider)
  const providerKey = getProviderKey({modelId, modelProvider, providerConnectionId, useOwnerBackedSyntheticProviderId})
  const providerId = getTrimmedValue(providerConnectionId) ?? providerKey
  const resolvedDefaultCapacity = Math.max(
    1,
    getProviderFamilyDefaultCapacity({getCodexDefaultMaxInflight, getNonCodexCapacity, providerFamily}),
  )
  const providerLimit = Math.max(1, maxInflightRequests ?? resolvedDefaultCapacity)
  const providerLabel = getTrimmedValue(providerName) ?? providerFamily

  return publishProviderBucketSnapshot({
    maxInflightRequests,
    providerFamily,
    providerId,
    providerKey,
    providerLimit,
    providerLimitVersion: getProviderLimitVersion({
      maxInflightRequests,
      providerConnectionUpdatedAt,
      providerFamily,
      providerKey,
      providerLimit,
      providerName: providerLabel,
      resolvedDefaultCapacity,
    }),
    providerName: providerLabel,
    providerUsesFamilyDefault: maxInflightRequests == null,
    resolvedDefaultCapacity,
  })
}

const getLeaseKey = ({leaseIdentity, providerKey}: {leaseIdentity: string; providerKey: string}): string => {
  return `${providerKey}\n${leaseIdentity}`
}

const getDateFromMs = (value: number): Date => {
  return new Date(value)
}

const getTimestampMs = (value: Date | string): number => {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

const getIsoTimestamp = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const getCountValue = (value: unknown): number => {
  return typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string'
        ? Number(value)
        : 0
}

const getEmptyProviderAdmissionLeaseReconciliationResult = (): ProviderAdmissionLeaseReconciliationResult => {
  return {
    durableRequestCloseoutLeaseCount: 0,
    expiredLeaseCount: 0,
    graceHeldLeaseCount: 0,
    holderDemotionLeaseCount: 0,
    suspectFreshHolderLeaseCount: 0,
    suspectFreshProofLeaseCount: 0,
  }
}

const addProviderAdmissionLeaseReconciliationResults = (
  left: ProviderAdmissionLeaseReconciliationResult,
  right: ProviderAdmissionLeaseReconciliationResult,
): ProviderAdmissionLeaseReconciliationResult => {
  return {
    durableRequestCloseoutLeaseCount: left.durableRequestCloseoutLeaseCount + right.durableRequestCloseoutLeaseCount,
    expiredLeaseCount: left.expiredLeaseCount + right.expiredLeaseCount,
    graceHeldLeaseCount: left.graceHeldLeaseCount + right.graceHeldLeaseCount,
    holderDemotionLeaseCount: left.holderDemotionLeaseCount + right.holderDemotionLeaseCount,
    suspectFreshHolderLeaseCount: left.suspectFreshHolderLeaseCount + right.suspectFreshHolderLeaseCount,
    suspectFreshProofLeaseCount: left.suspectFreshProofLeaseCount + right.suspectFreshProofLeaseCount,
  }
}

const getUniqueTrimmedValues = (values: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        const trimmed = String(value ?? '').trim()
        return trimmed.length > 0 ? [trimmed] : []
      }),
    ),
  )
}

const getSqlLiteralList = (values: string[]): string => {
  return values
    .map((value) => {
      return getSqlLiteral(value)
    })
    .join(', ')
}

const getHolderWorkerFreshness = (
  holder: ProviderAdmissionLeaseHolderWorkerDemotion,
): ProviderAdmissionLeaseHolderWorkerFreshness => {
  return holder.freshness ?? holder.state ?? 'demoted'
}

const getHolderWorkerFreshnessStartedAtMs = (holder: ProviderAdmissionLeaseHolderWorkerDemotion): number => {
  return getNormalizedTimestampMs(
    holder.demotedAtMs ?? holder.staleSinceMs ?? holder.missingSinceMs ?? holder.observedAtMs ?? 0,
  )
}

const getHolderWorkerGraceElapsed = ({
  graceMs,
  holder,
  nowMs,
}: {
  graceMs: number
  holder: ProviderAdmissionLeaseHolderWorkerDemotion
  nowMs: number
}): boolean => {
  return nowMs - getHolderWorkerFreshnessStartedAtMs(holder) >= getNormalizedGraceDurationMs(graceMs)
}

const getEligibleHolderDemotionTokens = ({
  graceMs,
  holders,
  nowMs,
}: {
  graceMs: number
  holders: ProviderAdmissionLeaseHolderWorkerDemotion[]
  nowMs: number
}): string[] => {
  return getUniqueTrimmedValues(
    holders.flatMap((holder) => {
      const freshness = getHolderWorkerFreshness(holder)
      const shouldDelete =
        freshness !== 'fresh'
        && getTrimmedValue(holder.holderToken) !== null
        && getHolderWorkerGraceElapsed({graceMs, holder, nowMs})

      return shouldDelete ? [holder.holderToken] : []
    }),
  )
}

const getGraceHeldHolderTokens = ({
  graceMs,
  holders,
  nowMs,
}: {
  graceMs: number
  holders: ProviderAdmissionLeaseHolderWorkerDemotion[]
  nowMs: number
}): string[] => {
  return getUniqueTrimmedValues(
    holders.flatMap((holder) => {
      const freshness = getHolderWorkerFreshness(holder)
      const isHeld =
        freshness !== 'fresh'
        && getTrimmedValue(holder.holderToken) !== null
        && !getHolderWorkerGraceElapsed({graceMs, holder, nowMs})

      return isHeld ? [holder.holderToken] : []
    }),
  )
}

const getFreshHolderTokens = (holders: ProviderAdmissionLeaseHolderWorkerDemotion[]): string[] => {
  return getUniqueTrimmedValues(
    holders.flatMap((holder) => {
      return getHolderWorkerFreshness(holder) === 'fresh' ? [holder.holderToken] : []
    }),
  )
}

const getReconciliationProofs = (
  input: ProviderAdmissionLeaseReconciliationInput,
): ProviderAdmissionLeaseSuspectFreshProof[] => {
  return [...(input.suspectFreshProofs ?? []), ...(input.suspectFreshHolderProofs ?? [])]
}

const getProviderAdmissionLeaseRecord = (row: ProviderAdmissionLeaseRow): ProviderAdmissionLeaseRecord => {
  const acquiredAtMs = getTimestampMs(row.acquiredAt)
  const heartbeatAtMs = getTimestampMs(row.heartbeatAt)
  const expiresAtMs = getTimestampMs(row.expiresAt)

  return {
    acquiredAt: getIsoTimestamp(row.acquiredAt),
    acquiredAtMs,
    endpointAvailabilityKey: row.endpointAvailabilityKey,
    expiresAt: getIsoTimestamp(row.expiresAt),
    expiresAtMs,
    heartbeatAt: getIsoTimestamp(row.heartbeatAt),
    heartbeatAtMs,
    holderToken: row.holderToken,
    leaseIdentity: row.leaseIdentity,
    leaseKind: row.leaseKind,
    probeAttemptId: row.probeAttemptId,
    providerKey: row.providerKey,
    requestAttemptId: row.requestAttemptId,
  }
}

const getProviderAdmissionLeaseSelectSql = () => {
  return `
    SELECT
      provider_key AS providerKey,
      lease_kind AS leaseKind,
      lease_identity AS leaseIdentity,
      request_attempt_id AS requestAttemptId,
      endpoint_availability_key AS endpointAvailabilityKey,
      probe_attempt_id AS probeAttemptId,
      holder_token AS holderToken,
      acquired_at AS acquiredAt,
      heartbeat_at AS heartbeatAt,
      expires_at AS expiresAt
    FROM app.provider_admission_lease
  `
}

const getCurrentSnapshot = (snapshot: ProviderBucketSnapshot): ProviderBucketSnapshot => {
  return currentProviderSnapshots.get(snapshot.providerKey) ?? publishProviderBucketSnapshot(snapshot)
}

const getRequestLeaseIdentityParts = (
  requestAttemptId: string | null | undefined,
): ProviderAdmissionLeaseIdentityParts | null => {
  const normalizedRequestAttemptId = getTrimmedValue(requestAttemptId)

  return normalizedRequestAttemptId === null
    ? null
    : {
        endpointAvailabilityKey: null,
        leaseKind: 'request',
        probeAttemptId: null,
        requestAttemptId: normalizedRequestAttemptId,
      }
}

const getProbeLeaseIdentityParts = ({
  endpointAvailabilityKey,
  probeAttemptId,
}: {
  endpointAvailabilityKey: string | null | undefined
  probeAttemptId: string | null | undefined
}): ProviderAdmissionLeaseIdentityParts | null => {
  const normalizedEndpointAvailabilityKey = getTrimmedValue(endpointAvailabilityKey)
  const normalizedProbeAttemptId = getTrimmedValue(probeAttemptId)

  return normalizedEndpointAvailabilityKey === null || normalizedProbeAttemptId === null
    ? null
    : {
        endpointAvailabilityKey: normalizedEndpointAvailabilityKey,
        leaseKind: 'probe',
        probeAttemptId: normalizedProbeAttemptId,
        requestAttemptId: null,
      }
}

const parseRequestLeaseIdentity = (leaseIdentity: string): ProviderAdmissionLeaseIdentityParts | null => {
  const requestPrefix = 'request:'

  return leaseIdentity.startsWith(requestPrefix)
    ? getRequestLeaseIdentityParts(leaseIdentity.slice(requestPrefix.length))
    : null
}

const parseProbeLeaseIdentity = (leaseIdentity: string): ProviderAdmissionLeaseIdentityParts | null => {
  const probePrefix = 'probe:'
  const rawIdentity = leaseIdentity.startsWith(probePrefix) ? leaseIdentity.slice(probePrefix.length) : ''
  const delimiterIndex = rawIdentity.lastIndexOf(':')

  return delimiterIndex <= 0 || delimiterIndex >= rawIdentity.length - 1
    ? null
    : getProbeLeaseIdentityParts({
        endpointAvailabilityKey: rawIdentity.slice(0, delimiterIndex),
        probeAttemptId: rawIdentity.slice(delimiterIndex + 1),
      })
}

const getLeaseIdentityParts = (input: {
  endpointAvailabilityKey?: string | null
  leaseIdentity: string
  leaseKind?: ProviderAdmissionLeaseKind
  probeAttemptId?: string | null
  requestAttemptId?: string | null
}): ProviderAdmissionLeaseIdentityParts => {
  const explicitParts =
    input.leaseKind === 'request'
      ? getRequestLeaseIdentityParts(input.requestAttemptId)
      : input.leaseKind === 'probe'
        ? getProbeLeaseIdentityParts({
            endpointAvailabilityKey: input.endpointAvailabilityKey,
            probeAttemptId: input.probeAttemptId,
          })
        : null
  const parsedParts =
    explicitParts ?? parseRequestLeaseIdentity(input.leaseIdentity) ?? parseProbeLeaseIdentity(input.leaseIdentity)
  const expectedLeaseIdentity =
    parsedParts?.leaseKind === 'request'
      ? getProviderAdmissionRequestLeaseIdentity(parsedParts.requestAttemptId ?? '')
      : parsedParts?.leaseKind === 'probe'
        ? getProviderAdmissionProbeLeaseIdentity({
            endpointAvailabilityKey: parsedParts.endpointAvailabilityKey ?? '',
            probeAttemptId: parsedParts.probeAttemptId ?? '',
          })
        : null

  if (parsedParts === null || expectedLeaseIdentity !== input.leaseIdentity) {
    throw new Error(`provider admission lease identity is not canonical: ${input.leaseIdentity}`)
  }

  return parsedParts
}

const getProviderAdmissionLeaseInsertSql = ({
  expiresAt,
  input,
  parts,
  startedAt,
}: {
  expiresAt: Date
  input: ProviderAdmissionLeaseAcquireInput
  parts: ProviderAdmissionLeaseIdentityParts
  startedAt: Date
}) => {
  return `
    INSERT INTO app.provider_admission_lease (
      provider_key,
      lease_kind,
      lease_identity,
      request_attempt_id,
      endpoint_availability_key,
      probe_attempt_id,
      holder_token,
      acquired_at,
      heartbeat_at,
      expires_at
    ) VALUES (
      ${getSqlLiteral(input.snapshot.providerKey)},
      ${getSqlLiteral(parts.leaseKind)},
      ${getSqlLiteral(input.leaseIdentity)},
      ${getSqlLiteral(parts.requestAttemptId)},
      ${getSqlLiteral(parts.endpointAvailabilityKey)},
      ${getSqlLiteral(parts.probeAttemptId)},
      ${getSqlLiteral(input.holderToken)},
      ${getSqlLiteral(startedAt)},
      ${getSqlLiteral(startedAt)},
      ${getSqlLiteral(expiresAt)}
    )
  `
}

const getProviderAdmissionLeaseOwnerUrl = async (): Promise<string> => {
  const configuredUrl = String(process.env.SERVER_DUCKDB_OWNER_URL ?? '').trim()
  const ownerUrl = configuredUrl.length > 0 ? configuredUrl : await getCurrentServerDuckdbOwnerUrl()

  if (ownerUrl === null) {
    throw new Error('DuckDB owner URL is required for provider admission lease owner proxy')
  }

  return ownerUrl.endsWith('/') ? ownerUrl.slice(0, -1) : ownerUrl
}

const requestProviderAdmissionLeaseOwner = async <T>({body, path}: {body: unknown; path: string}): Promise<T> => {
  const ownerUrl = await getProviderAdmissionLeaseOwnerUrl()
  const response = await fetch(
    `${ownerUrl}${duckdbOwnerPrivateApiPrefix}${providerAdmissionLeaseOwnerApiPath}${path}`,
    {body: JSON.stringify(body), headers: {'content-type': 'application/json'}, method: 'POST'},
  )
  const text = await response.text()
  const parsed = text.trim().length === 0 ? null : (JSON.parse(text) as {data?: T; error?: unknown})
  const error = parsed && 'error' in parsed ? parsed.error : null

  if (!response.ok || error) {
    throw new Error(typeof error === 'string' ? error : text || response.statusText)
  }

  if (!parsed || !('data' in parsed)) {
    throw new Error('provider admission owner returned invalid response')
  }

  return parsed.data as T
}

const withProviderAdmissionLeaseSerialization = async <T>(
  providerKey: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previousQueue = providerAdmissionLeaseOperationQueues.get(providerKey) ?? Promise.resolve()
  const currentOperation = previousQueue
    .catch(() => {
      return undefined
    })
    .then(operation)
  const currentQueue = currentOperation.then(
    () => {
      return undefined
    },
    () => {
      return undefined
    },
  )

  providerAdmissionLeaseOperationQueues.set(providerKey, currentQueue)

  try {
    return await currentOperation
  } finally {
    if (providerAdmissionLeaseOperationQueues.get(providerKey) === currentQueue) {
      providerAdmissionLeaseOperationQueues.delete(providerKey)
    }
  }
}

const getActiveProviderLeaseCount = async ({
  now,
  providerKey,
  tx,
}: {
  now: Date
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  const [row] = await tx.queryJson<{leaseCount: number | string | bigint}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND expires_at > ${getSqlLiteral(now)}
  `)

  return getCountValue(row?.leaseCount)
}

const getActiveProviderProbeLeaseCount = async ({
  endpointAvailabilityKey,
  now,
  providerKey,
  tx,
}: {
  endpointAvailabilityKey?: string | null
  now: Date
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  const endpointPredicate = getTrimmedValue(endpointAvailabilityKey)
    ? `AND endpoint_availability_key = ${getSqlLiteral(getTrimmedValue(endpointAvailabilityKey))}`
    : ''
  const [row] = await tx.queryJson<{leaseCount: number | string | bigint}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND lease_kind = 'probe'
      AND expires_at > ${getSqlLiteral(now)}
      ${endpointPredicate}
  `)

  return getCountValue(row?.leaseCount)
}

const getProviderProbeOccupancyVersion = ({
  providerKey,
  providerLeasedProbeCalls,
}: {
  providerKey: string
  providerLeasedProbeCalls: number
}): string => {
  const versionCounter = providerProbeOccupancyVersionCounters.get(providerKey) ?? 0

  return createHash('sha256').update(`${providerKey}:${providerLeasedProbeCalls}:${versionCounter}`).digest('hex')
}

const incrementProviderProbeOccupancyVersion = (providerKey: string): number => {
  const nextCounter = (providerProbeOccupancyVersionCounters.get(providerKey) ?? 0) + 1

  providerProbeOccupancyVersionCounters.set(providerKey, nextCounter)
  return nextCounter
}

const incrementProviderProbeOccupancyVersionForDeletedRows = (rows: DeletedProviderAdmissionLeaseRow[]): number => {
  const providerKeys = rows.reduce<string[]>((keys, row) => {
    return row.leaseKind === 'probe' && !keys.includes(row.providerKey) ? [...keys, row.providerKey] : keys
  }, [])

  return providerKeys.reduce((count, providerKey) => {
    incrementProviderProbeOccupancyVersion(providerKey)
    return count + 1
  }, 0)
}

export const getProviderAdmissionLeaseTelemetry = async ({
  nowMs = Date.now(),
  providerKey,
}: {
  nowMs?: number
  providerKey: string
}): Promise<ProviderAdmissionLeaseTelemetry> => {
  const now = getDateFromMs(getNormalizedTimestampMs(nowMs))
  const [requestRow, probeRow] = await Promise.all([
    getAppDatabaseService().queryJson<{leaseCount: number | string | bigint}>(`
      SELECT COUNT(*) AS leaseCount
      FROM app.provider_admission_lease
      WHERE provider_key = ${getSqlLiteral(providerKey)}
        AND lease_kind = 'request'
        AND expires_at > ${getSqlLiteral(now)}
    `),
    getAppDatabaseService().queryJson<{leaseCount: number | string | bigint}>(`
      SELECT COUNT(*) AS leaseCount
      FROM app.provider_admission_lease
      WHERE provider_key = ${getSqlLiteral(providerKey)}
        AND lease_kind = 'probe'
        AND expires_at > ${getSqlLiteral(now)}
    `),
  ])
  const providerLeasedLiveRequests = getCountValue(requestRow[0]?.leaseCount)
  const providerLeasedProbeCalls = getCountValue(probeRow[0]?.leaseCount)

  return {
    providerKey,
    providerLeasedLiveRequests,
    providerLeasedProbeCalls,
    providerProbeOccupancyVersion: getProviderProbeOccupancyVersion({providerKey, providerLeasedProbeCalls}),
    sampledAtMs: now.getTime(),
  }
}

const getProviderAdmissionLeaseByIdentity = async ({
  leaseIdentity,
  tx,
}: {
  leaseIdentity: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<ProviderAdmissionLeaseRecord | null> => {
  const [row] = await tx.queryJson<ProviderAdmissionLeaseRow>(`
    ${getProviderAdmissionLeaseSelectSql()}
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
    LIMIT 1
  `)

  return row === undefined ? null : getProviderAdmissionLeaseRecord(row)
}

const deleteExpiredProviderAdmissionLeases = async ({
  now,
  providerKey,
  tx,
}: {
  now: Date
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  const rows = await tx.queryJson<DeletedProviderAdmissionLeaseRow>(`
    DELETE FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND expires_at <= ${getSqlLiteral(now)}
    RETURNING
      provider_key AS providerKey,
      lease_kind AS leaseKind,
      lease_identity AS leaseIdentity
  `)

  incrementProviderProbeOccupancyVersionForDeletedRows(rows)
  return rows.length
}

const deleteExpiredProviderAdmissionLeaseIdentity = async ({
  leaseIdentity,
  now,
  tx,
}: {
  leaseIdentity: string
  now: Date
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<void> => {
  const rows = await tx.queryJson<DeletedProviderAdmissionLeaseRow>(`
    DELETE FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
      AND expires_at <= ${getSqlLiteral(now)}
    RETURNING
      provider_key AS providerKey,
      lease_kind AS leaseKind,
      lease_identity AS leaseIdentity
  `)

  incrementProviderProbeOccupancyVersionForDeletedRows(rows)
}

const getProviderAdmissionLeaseProviderKeys = async (): Promise<string[]> => {
  return (
    await getAppDatabaseService().queryJson<{providerKey: string}>(`
      SELECT DISTINCT provider_key AS providerKey
      FROM app.provider_admission_lease
      ORDER BY provider_key ASC
    `)
  ).map((row) => {
    return row.providerKey
  })
}

const getReconciliationProviderKeys = async (input: ProviderAdmissionLeaseReconciliationInput): Promise<string[]> => {
  const existingProviderKeys = await getProviderAdmissionLeaseProviderKeys()
  const inputProviderKeys = [
    ...(input.terminalRequestAttemptCloseouts ?? []).map((closeout) => {
      return closeout.providerKey
    }),
    ...getReconciliationProofs(input).map((proof) => {
      return proof.providerKey
    }),
  ]

  return getUniqueTrimmedValues([...existingProviderKeys, ...inputProviderKeys])
}

const deleteDurableRequestCloseoutLeases = async ({
  closeouts,
  providerKey,
  tx,
}: {
  closeouts: ProviderAdmissionLeaseTerminalRequestCloseout[]
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  const requestAttemptIds = getUniqueTrimmedValues(
    closeouts.flatMap((closeout) => {
      const closeoutProviderKey = getTrimmedValue(closeout.providerKey)
      return closeoutProviderKey !== null && closeoutProviderKey !== providerKey ? [] : [closeout.requestAttemptId]
    }),
  )

  if (requestAttemptIds.length === 0) {
    return 0
  }

  const rows = await tx.queryJson<{leaseIdentity: string}>(`
    DELETE FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND lease_kind = 'request'
      AND request_attempt_id IN (${getSqlLiteralList(requestAttemptIds)})
      AND lease_identity IN (${getSqlLiteralList(
        requestAttemptIds.map((requestAttemptId) => {
          return getProviderAdmissionRequestLeaseIdentity(requestAttemptId)
        }),
      )})
    RETURNING lease_identity AS leaseIdentity
  `)

  return rows.length
}

const getSuspectFreshProofPredicate = (proof: ProviderAdmissionLeaseSuspectFreshProof): string => {
  const holderPredicate = getTrimmedValue(proof.holderToken)
    ? `AND holder_token = ${getSqlLiteral(getTrimmedValue(proof.holderToken))}`
    : ''
  const kindPredicate = proof.leaseKind ? `AND lease_kind = ${getSqlLiteral(proof.leaseKind)}` : ''

  return `(lease_identity = ${getSqlLiteral(proof.leaseIdentity)} ${holderPredicate} ${kindPredicate})`
}

const deleteSuspectFreshProofLeases = async ({
  proofs,
  providerKey,
  tx,
}: {
  proofs: ProviderAdmissionLeaseSuspectFreshProof[]
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  const predicates = proofs.flatMap((proof) => {
    return getTrimmedValue(proof.providerKey) === providerKey && getTrimmedValue(proof.leaseIdentity)
      ? [getSuspectFreshProofPredicate(proof)]
      : []
  })

  if (predicates.length === 0) {
    return 0
  }

  const rows = await tx.queryJson<DeletedProviderAdmissionLeaseRow>(`
    DELETE FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND (${predicates.join(' OR ')})
    RETURNING
      provider_key AS providerKey,
      lease_kind AS leaseKind,
      lease_identity AS leaseIdentity
  `)

  incrementProviderProbeOccupancyVersionForDeletedRows(rows)
  return rows.length
}

const deleteHolderDemotionLeases = async ({
  holderTokens,
  providerKey,
  tx,
}: {
  holderTokens: string[]
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  if (holderTokens.length === 0) {
    return 0
  }

  const rows = await tx.queryJson<DeletedProviderAdmissionLeaseRow>(`
    DELETE FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND holder_token IN (${getSqlLiteralList(holderTokens)})
    RETURNING
      provider_key AS providerKey,
      lease_kind AS leaseKind,
      lease_identity AS leaseIdentity
  `)

  incrementProviderProbeOccupancyVersionForDeletedRows(rows)
  return rows.length
}

const getActiveLeaseCountForHolderTokens = async ({
  holderTokens,
  now,
  providerKey,
  tx,
}: {
  holderTokens: string[]
  now: Date
  providerKey: string
  tx: {queryJson: <T>(statement: string) => Promise<T[]>}
}): Promise<number> => {
  if (holderTokens.length === 0) {
    return 0
  }

  const [row] = await tx.queryJson<{leaseCount: number | string | bigint}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
      AND holder_token IN (${getSqlLiteralList(holderTokens)})
      AND expires_at > ${getSqlLiteral(now)}
  `)

  return getCountValue(row?.leaseCount)
}

const reconcileProviderAdmissionLeasesForProvider = async ({
  input,
  providerKey,
}: {
  input: ProviderAdmissionLeaseReconciliationInput
  providerKey: string
}): Promise<ProviderAdmissionLeaseReconciliationResult> => {
  return withProviderAdmissionLeaseSerialization(providerKey, async () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const nowMs = getNormalizedTimestampMs(input.nowMs ?? Date.now())
      const now = getDateFromMs(nowMs)
      const holderGraceMs = getNormalizedGraceDurationMs(input.holderGraceMs ?? providerAdmissionLeaseTtlMs)
      const holderWorkerDemotions = input.holderWorkerDemotions ?? []
      const durableRequestCloseoutLeaseCount = await deleteDurableRequestCloseoutLeases({
        closeouts: input.terminalRequestAttemptCloseouts ?? [],
        providerKey,
        tx,
      })
      const suspectFreshProofLeaseCount = await deleteSuspectFreshProofLeases({
        proofs: getReconciliationProofs(input),
        providerKey,
        tx,
      })
      const holderDemotionLeaseCount = await deleteHolderDemotionLeases({
        holderTokens: getEligibleHolderDemotionTokens({graceMs: holderGraceMs, holders: holderWorkerDemotions, nowMs}),
        providerKey,
        tx,
      })
      const expiredLeaseCount = await deleteExpiredProviderAdmissionLeases({now, providerKey, tx})
      const graceHeldLeaseCount = await getActiveLeaseCountForHolderTokens({
        holderTokens: getGraceHeldHolderTokens({graceMs: holderGraceMs, holders: holderWorkerDemotions, nowMs}),
        now,
        providerKey,
        tx,
      })
      const suspectFreshHolderLeaseCount = await getActiveLeaseCountForHolderTokens({
        holderTokens: getFreshHolderTokens(holderWorkerDemotions),
        now,
        providerKey,
        tx,
      })

      return {
        durableRequestCloseoutLeaseCount,
        expiredLeaseCount,
        graceHeldLeaseCount,
        holderDemotionLeaseCount,
        suspectFreshHolderLeaseCount,
        suspectFreshProofLeaseCount,
      }
    })
  })
}

const reconcileProviderAdmissionLeasesForProviders = async ({
  input,
  providerKeys,
  total = getEmptyProviderAdmissionLeaseReconciliationResult(),
}: {
  input: ProviderAdmissionLeaseReconciliationInput
  providerKeys: string[]
  total?: ProviderAdmissionLeaseReconciliationResult
}): Promise<ProviderAdmissionLeaseReconciliationResult> => {
  const [providerKey = '', ...remainingProviderKeys] = providerKeys

  return providerKey
    ? reconcileProviderAdmissionLeasesForProviders({
        input,
        providerKeys: remainingProviderKeys,
        total: addProviderAdmissionLeaseReconciliationResults(
          total,
          await reconcileProviderAdmissionLeasesForProvider({input, providerKey}),
        ),
      })
    : total
}

const getActiveProviderLeases = (providerKey: string, nowMs: number): ProviderAdmissionLease[] => {
  const entries = Array.from(providerAdmissionLeases.entries())
  const activeEntries = entries.filter(([, lease]) => {
    return lease.expiresAtMs > nowMs
  })
  const staleKeys = entries.flatMap(([key, lease]) => {
    return lease.expiresAtMs > nowMs ? [] : [key]
  })

  staleKeys.reduce((count, key) => {
    providerAdmissionLeases.delete(key)
    return count + 1
  }, 0)

  return activeEntries.flatMap(([, lease]) => {
    return lease.providerKey === providerKey ? [lease] : []
  })
}

export const acquireProviderAdmissionLease = ({
  holderToken,
  leaseIdentity,
  nowMs = Date.now(),
  snapshot,
  ttlMs = providerAdmissionLeaseTtlMs,
}: {
  holderToken: string
  leaseIdentity: string
  nowMs?: number
  snapshot: ProviderBucketSnapshot
  ttlMs?: number
}): ProviderAdmissionLeaseAcquireResult => {
  const currentSnapshot = getCurrentSnapshot(snapshot)
  const leaseKey = getLeaseKey({leaseIdentity, providerKey: snapshot.providerKey})
  const existingLease = providerAdmissionLeases.get(leaseKey) ?? null
  const activeLeases = getActiveProviderLeases(snapshot.providerKey, nowMs)
  const activeLeaseCount = activeLeases.length
  const probeParts = parseProbeLeaseIdentity(leaseIdentity)
  const activeProbeLeaseCount = activeLeases.filter((lease) => {
    return (
      lease.leaseKind === 'probe'
      && (!probeParts?.endpointAvailabilityKey || lease.endpointAvailabilityKey === probeParts.endpointAvailabilityKey)
    )
  }).length
  const existingIsActiveSameHolder =
    existingLease !== null && existingLease.expiresAtMs > nowMs && existingLease.holderToken === holderToken
  const staleProviderLimitSnapshot = snapshot.providerLimitVersion !== currentSnapshot.providerLimitVersion

  if (existingIsActiveSameHolder) {
    return {
      acquired: true,
      activeLeaseCount,
      activeProbeLeaseCount,
      alreadyHeld: true,
      currentSnapshot,
      providerLimit: currentSnapshot.providerLimit,
      providerLimitVersion: existingLease.providerLimitVersion,
      staleProviderLimitSnapshot,
    }
  }

  if (staleProviderLimitSnapshot) {
    return {
      acquired: false,
      activeLeaseCount,
      activeProbeLeaseCount,
      currentSnapshot,
      providerLimit: currentSnapshot.providerLimit,
      providerLimitVersion: currentSnapshot.providerLimitVersion,
      reason: 'staleProviderLimitSnapshot',
      staleProviderLimitSnapshot: true,
    }
  }

  if (activeLeaseCount >= currentSnapshot.providerLimit) {
    return {
      acquired: false,
      activeLeaseCount,
      activeProbeLeaseCount,
      currentSnapshot,
      providerLimit: currentSnapshot.providerLimit,
      providerLimitVersion: currentSnapshot.providerLimitVersion,
      reason: 'capacity',
      staleProviderLimitSnapshot: false,
    }
  }

  providerAdmissionLeases.set(leaseKey, {
    acquiredAtMs: nowMs,
    endpointAvailabilityKey: probeParts?.endpointAvailabilityKey ?? null,
    expiresAtMs: nowMs + getNormalizedLeaseDurationMs(ttlMs),
    heartbeatAtMs: nowMs,
    holderToken,
    leaseIdentity,
    leaseKind: probeParts?.leaseKind ?? 'request',
    providerKey: snapshot.providerKey,
    providerLimitVersion: snapshot.providerLimitVersion,
  })

  if (probeParts?.leaseKind === 'probe') {
    incrementProviderProbeOccupancyVersion(snapshot.providerKey)
  }

  return {
    acquired: true,
    activeLeaseCount: activeLeaseCount + 1,
    activeProbeLeaseCount: probeParts ? activeProbeLeaseCount + 1 : activeProbeLeaseCount,
    alreadyHeld: false,
    currentSnapshot,
    providerLimit: currentSnapshot.providerLimit,
    providerLimitVersion: currentSnapshot.providerLimitVersion,
    staleProviderLimitSnapshot: false,
  }
}

export const releaseProviderAdmissionLease = ({
  holderToken,
  leaseIdentity,
  providerKey,
}: {
  holderToken: string
  leaseIdentity: string
  providerKey: string
}): boolean => {
  const leaseKey = getLeaseKey({leaseIdentity, providerKey})
  const lease = providerAdmissionLeases.get(leaseKey) ?? null
  const shouldRelease = lease?.holderToken === holderToken

  if (shouldRelease && lease.leaseKind === 'probe') {
    incrementProviderProbeOccupancyVersion(providerKey)
  }

  return shouldRelease ? providerAdmissionLeases.delete(leaseKey) : false
}

export const acquireProviderAdmissionLeaseOnCurrentOwner = async (
  input: ProviderAdmissionLeaseAcquireInput,
): Promise<ProviderAdmissionLeaseAcquireResult> => {
  await ensureCurrentDuckdbOwnerLease()

  return withProviderAdmissionLeaseSerialization(input.snapshot.providerKey, async () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const nowMs = getNormalizedTimestampMs(input.nowMs ?? Date.now())
      const now = getDateFromMs(nowMs)
      const currentSnapshot = getCurrentSnapshot(input.snapshot)
      const staleProviderLimitSnapshot = input.snapshot.providerLimitVersion !== currentSnapshot.providerLimitVersion
      const parts = getLeaseIdentityParts(input)
      const existingLease = await getProviderAdmissionLeaseByIdentity({leaseIdentity: input.leaseIdentity, tx})
      const activeLeaseCount = await getActiveProviderLeaseCount({now, providerKey: input.snapshot.providerKey, tx})
      const activeProbeLeaseCount = await getActiveProviderProbeLeaseCount({
        endpointAvailabilityKey: parts.endpointAvailabilityKey,
        now,
        providerKey: input.snapshot.providerKey,
        tx,
      })
      const existingLeaseIsActive = existingLease !== null && existingLease.expiresAtMs > nowMs
      const existingLeaseIsSameProvider =
        existingLeaseIsActive && existingLease.providerKey === input.snapshot.providerKey
      const existingLeaseIsSameHolder = existingLeaseIsSameProvider && existingLease?.holderToken === input.holderToken

      if (existingLeaseIsSameHolder) {
        return {
          acquired: true,
          activeLeaseCount,
          activeProbeLeaseCount,
          alreadyHeld: true,
          currentSnapshot,
          lease: existingLease,
          providerLimit: currentSnapshot.providerLimit,
          providerLimitVersion: input.snapshot.providerLimitVersion,
          staleProviderLimitSnapshot,
        }
      }

      if (existingLeaseIsActive) {
        return {
          acquired: false,
          activeLeaseCount,
          activeProbeLeaseCount,
          alreadyHeld: true,
          currentSnapshot,
          lease: existingLease,
          providerLimit: currentSnapshot.providerLimit,
          providerLimitVersion: currentSnapshot.providerLimitVersion,
          reason: 'alreadyHeld',
          staleProviderLimitSnapshot,
        }
      }

      if (staleProviderLimitSnapshot) {
        return {
          acquired: false,
          activeLeaseCount,
          activeProbeLeaseCount,
          currentSnapshot,
          providerLimit: currentSnapshot.providerLimit,
          providerLimitVersion: currentSnapshot.providerLimitVersion,
          reason: 'staleProviderLimitSnapshot',
          staleProviderLimitSnapshot: true,
        }
      }

      await deleteExpiredProviderAdmissionLeaseIdentity({leaseIdentity: input.leaseIdentity, now, tx})
      await deleteExpiredProviderAdmissionLeases({now, providerKey: input.snapshot.providerKey, tx})

      const reconciledActiveLeaseCount = await getActiveProviderLeaseCount({
        now,
        providerKey: input.snapshot.providerKey,
        tx,
      })
      const reconciledActiveProbeLeaseCount = await getActiveProviderProbeLeaseCount({
        endpointAvailabilityKey: parts.endpointAvailabilityKey,
        now,
        providerKey: input.snapshot.providerKey,
        tx,
      })

      if (reconciledActiveLeaseCount >= currentSnapshot.providerLimit) {
        return {
          acquired: false,
          activeLeaseCount: reconciledActiveLeaseCount,
          activeProbeLeaseCount: reconciledActiveProbeLeaseCount,
          currentSnapshot,
          providerLimit: currentSnapshot.providerLimit,
          providerLimitVersion: currentSnapshot.providerLimitVersion,
          reason: 'capacity',
          staleProviderLimitSnapshot: false,
        }
      }

      const ttlMs = getNormalizedLeaseDurationMs(input.ttlMs ?? providerAdmissionLeaseTtlMs)
      const expiresAt = getDateFromMs(nowMs + ttlMs)

      await tx.run(getProviderAdmissionLeaseInsertSql({expiresAt, input, parts, startedAt: now}))

      if (parts.leaseKind === 'probe') {
        incrementProviderProbeOccupancyVersion(input.snapshot.providerKey)
      }

      const lease = await getProviderAdmissionLeaseByIdentity({leaseIdentity: input.leaseIdentity, tx})

      return {
        acquired: true,
        activeLeaseCount: reconciledActiveLeaseCount + 1,
        activeProbeLeaseCount:
          parts.leaseKind === 'probe' ? reconciledActiveProbeLeaseCount + 1 : reconciledActiveProbeLeaseCount,
        alreadyHeld: false,
        currentSnapshot,
        lease: lease ?? undefined,
        providerLimit: currentSnapshot.providerLimit,
        providerLimitVersion: currentSnapshot.providerLimitVersion,
        staleProviderLimitSnapshot: false,
      }
    })
  })
}

export const acquireProviderAdmissionLeaseThroughOwner = async (
  input: ProviderAdmissionLeaseAcquireInput,
): Promise<ProviderAdmissionLeaseAcquireResult> => {
  return canCurrentServerOwnDuckdb()
    ? acquireProviderAdmissionLeaseOnCurrentOwner(input)
    : requestProviderAdmissionLeaseOwner<ProviderAdmissionLeaseAcquireResult>({body: input, path: '/acquire'})
}

export const acquireProviderAdmissionLeasePersisted = acquireProviderAdmissionLeaseThroughOwner

export const heartbeatProviderAdmissionLeaseOnCurrentOwner = async (
  input: ProviderAdmissionLeaseHeartbeatInput,
): Promise<ProviderAdmissionLeaseHeartbeatResult> => {
  await ensureCurrentDuckdbOwnerLease()

  return withProviderAdmissionLeaseSerialization(input.providerKey, async () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const nowMs = getNormalizedTimestampMs(input.nowMs ?? Date.now())
      const now = getDateFromMs(nowMs)
      const expiresAt = getDateFromMs(nowMs + getNormalizedLeaseDurationMs(input.ttlMs ?? providerAdmissionLeaseTtlMs))
      const [row] = await tx.queryJson<ProviderAdmissionLeaseRow>(`
        UPDATE app.provider_admission_lease
        SET heartbeat_at = ${getSqlLiteral(now)},
            expires_at = ${getSqlLiteral(expiresAt)}
        WHERE provider_key = ${getSqlLiteral(input.providerKey)}
          AND lease_identity = ${getSqlLiteral(input.leaseIdentity)}
          AND holder_token = ${getSqlLiteral(input.holderToken)}
        RETURNING
          provider_key AS providerKey,
          lease_kind AS leaseKind,
          lease_identity AS leaseIdentity,
          request_attempt_id AS requestAttemptId,
          endpoint_availability_key AS endpointAvailabilityKey,
          probe_attempt_id AS probeAttemptId,
          holder_token AS holderToken,
          acquired_at AS acquiredAt,
          heartbeat_at AS heartbeatAt,
          expires_at AS expiresAt
      `)

      if (row !== undefined) {
        return {heartbeat: true, lease: getProviderAdmissionLeaseRecord(row)}
      }

      const existingLease = await getProviderAdmissionLeaseByIdentity({leaseIdentity: input.leaseIdentity, tx})
      const reason = existingLease !== null && existingLease.providerKey === input.providerKey ? 'notHolder' : 'missing'

      return {heartbeat: false, reason}
    })
  })
}

export const heartbeatProviderAdmissionLeaseThroughOwner = async (
  input: ProviderAdmissionLeaseHeartbeatInput,
): Promise<ProviderAdmissionLeaseHeartbeatResult> => {
  return canCurrentServerOwnDuckdb()
    ? heartbeatProviderAdmissionLeaseOnCurrentOwner(input)
    : requestProviderAdmissionLeaseOwner<ProviderAdmissionLeaseHeartbeatResult>({body: input, path: '/heartbeat'})
}

export const releaseProviderAdmissionLeaseWithResultOnCurrentOwner = async (
  input: ProviderAdmissionLeaseReleaseInput,
): Promise<ProviderAdmissionLeaseReleaseResult> => {
  await ensureCurrentDuckdbOwnerLease()

  return withProviderAdmissionLeaseSerialization(input.providerKey, async () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const rows = await tx.queryJson<DeletedProviderAdmissionLeaseRow>(`
        DELETE FROM app.provider_admission_lease
        WHERE provider_key = ${getSqlLiteral(input.providerKey)}
          AND lease_identity = ${getSqlLiteral(input.leaseIdentity)}
          AND holder_token = ${getSqlLiteral(input.holderToken)}
        RETURNING
          provider_key AS providerKey,
          lease_kind AS leaseKind,
          lease_identity AS leaseIdentity
      `)

      if (rows.length > 0) {
        incrementProviderProbeOccupancyVersionForDeletedRows(rows)
        return {released: true}
      }

      const existingLease = await getProviderAdmissionLeaseByIdentity({leaseIdentity: input.leaseIdentity, tx})
      const reason = existingLease !== null && existingLease.providerKey === input.providerKey ? 'notHolder' : 'missing'

      return {released: false, reason}
    })
  })
}

export const releaseProviderAdmissionLeaseOnCurrentOwner = async (
  input: ProviderAdmissionLeaseReleaseInput,
): Promise<boolean> => {
  return (await releaseProviderAdmissionLeaseWithResultOnCurrentOwner(input)).released
}

export const releaseProviderAdmissionLeaseWithResultThroughOwner = async (
  input: ProviderAdmissionLeaseReleaseInput,
): Promise<ProviderAdmissionLeaseReleaseResult> => {
  return canCurrentServerOwnDuckdb()
    ? releaseProviderAdmissionLeaseWithResultOnCurrentOwner(input)
    : requestProviderAdmissionLeaseOwner<ProviderAdmissionLeaseReleaseResult>({body: input, path: '/release-result'})
}

export const releaseProviderAdmissionLeaseThroughOwner = async (
  input: ProviderAdmissionLeaseReleaseInput,
): Promise<boolean> => {
  return canCurrentServerOwnDuckdb()
    ? releaseProviderAdmissionLeaseOnCurrentOwner(input)
    : requestProviderAdmissionLeaseOwner<boolean>({body: input, path: '/release'})
}

export const expireProviderAdmissionLeasesOnCurrentOwner = async (
  input: ProviderAdmissionLeaseExpiryInput,
): Promise<ProviderAdmissionLeaseExpiryResult> => {
  await ensureCurrentDuckdbOwnerLease()

  return withProviderAdmissionLeaseSerialization(input.providerKey, async () => {
    return getAppDatabaseService().transaction(async (tx) => {
      const expiredLeaseCount = await deleteExpiredProviderAdmissionLeases({
        now: getDateFromMs(getNormalizedTimestampMs(input.nowMs ?? Date.now())),
        providerKey: input.providerKey,
        tx,
      })

      return {expiredLeaseCount}
    })
  })
}

export const expireProviderAdmissionLeasesThroughOwner = async (
  input: ProviderAdmissionLeaseExpiryInput,
): Promise<ProviderAdmissionLeaseExpiryResult> => {
  return canCurrentServerOwnDuckdb()
    ? expireProviderAdmissionLeasesOnCurrentOwner(input)
    : requestProviderAdmissionLeaseOwner<ProviderAdmissionLeaseExpiryResult>({body: input, path: '/expire'})
}

export const reconcileProviderAdmissionLeasesOnCurrentOwner = async (
  input: ProviderAdmissionLeaseReconciliationInput = {},
): Promise<ProviderAdmissionLeaseReconciliationResult> => {
  await ensureCurrentDuckdbOwnerLease()

  return reconcileProviderAdmissionLeasesForProviders({input, providerKeys: await getReconciliationProviderKeys(input)})
}

export const reconcileProviderAdmissionLeasesThroughOwner = async (
  input: ProviderAdmissionLeaseReconciliationInput = {},
): Promise<ProviderAdmissionLeaseReconciliationResult> => {
  return canCurrentServerOwnDuckdb()
    ? reconcileProviderAdmissionLeasesOnCurrentOwner(input)
    : requestProviderAdmissionLeaseOwner<ProviderAdmissionLeaseReconciliationResult>({body: input, path: '/reconcile'})
}

export const resetProviderAdmissionLeaseForTests = (): void => {
  currentProviderSnapshots.clear()
  providerAdmissionLeases.clear()
  providerAdmissionLeaseOperationQueues.clear()
  providerProbeOccupancyVersionCounters.clear()
}

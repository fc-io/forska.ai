import {createHash} from 'node:crypto'

import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getNormalizedProviderKeyProvider, getProviderKey} from './providerKey.ts'

type Capacity = {maxInflight: number; maxBurst: number; workerCount: number}

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
      alreadyHeld: boolean
      currentSnapshot: ProviderBucketSnapshot
      providerLimit: number
      providerLimitVersion: string
      staleProviderLimitSnapshot: boolean
    }
  | {
      acquired: false
      activeLeaseCount: number
      currentSnapshot: ProviderBucketSnapshot
      providerLimit: number
      providerLimitVersion: string
      reason: 'capacity' | 'staleProviderLimitSnapshot'
      staleProviderLimitSnapshot: boolean
    }

type ProviderAdmissionLease = {
  expiresAtMs: number
  holderToken: string
  leaseIdentity: string
  providerKey: string
  providerLimitVersion: string
}

const currentProviderSnapshots = new Map<string, ProviderBucketSnapshot>()
const providerAdmissionLeases = new Map<string, ProviderAdmissionLease>()
const defaultLeaseTtlMs = 60_000

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

const getCurrentSnapshot = (snapshot: ProviderBucketSnapshot): ProviderBucketSnapshot => {
  return currentProviderSnapshots.get(snapshot.providerKey) ?? publishProviderBucketSnapshot(snapshot)
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
  ttlMs = defaultLeaseTtlMs,
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
  const existingIsActiveSameHolder =
    existingLease !== null && existingLease.expiresAtMs > nowMs && existingLease.holderToken === holderToken
  const staleProviderLimitSnapshot = snapshot.providerLimitVersion !== currentSnapshot.providerLimitVersion

  if (existingIsActiveSameHolder) {
    return {
      acquired: true,
      activeLeaseCount,
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
      currentSnapshot,
      providerLimit: currentSnapshot.providerLimit,
      providerLimitVersion: currentSnapshot.providerLimitVersion,
      reason: 'capacity',
      staleProviderLimitSnapshot: false,
    }
  }

  providerAdmissionLeases.set(leaseKey, {
    expiresAtMs: nowMs + Math.max(1, ttlMs),
    holderToken,
    leaseIdentity,
    providerKey: snapshot.providerKey,
    providerLimitVersion: snapshot.providerLimitVersion,
  })

  return {
    acquired: true,
    activeLeaseCount: activeLeaseCount + 1,
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

  return shouldRelease ? providerAdmissionLeases.delete(leaseKey) : false
}

export const resetProviderAdmissionLeaseForTests = (): void => {
  currentProviderSnapshots.clear()
  providerAdmissionLeases.clear()
}

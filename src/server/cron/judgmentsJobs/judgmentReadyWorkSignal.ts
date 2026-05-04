import {judgmentBacklogControllerConstants} from './judgmentBacklogController.ts'

type JudgmentReadyWorkClaimResult = {
  claimedCount: number
  jobId: string
  providerKey: string
  recordedAtMs: number
  requestedCount: number
}

type JudgmentReadyWorkSignalInput = {
  jobId: string
  ownerBacked: boolean
  providerKey: string
  readyCount: number | null | undefined
}

type JudgmentReadyWorkSignal = {
  readyCount: number
  source: 'claimResultFallback' | 'ownerBackedAssumedReady' | 'readyCount'
}

const claimResultsByJobAndProvider = new Map<string, JudgmentReadyWorkClaimResult>()

const getClaimResultKey = ({jobId, providerKey}: {jobId: string; providerKey: string}): string => {
  return [jobId, providerKey].join('\n')
}

const getNonNegativeInteger = (value: number | null | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

const getFreshClaimResult = ({
  jobId,
  nowMs,
  providerKey,
}: {
  jobId: string
  nowMs: number
  providerKey: string
}): JudgmentReadyWorkClaimResult | null => {
  const result = claimResultsByJobAndProvider.get(getClaimResultKey({jobId, providerKey}))
  const maxAgeMs = judgmentBacklogControllerConstants.successfulLeaseWindowMs
  const fresh = result && nowMs - result.recordedAtMs <= maxAgeMs

  return fresh ? result : null
}

export const recordJudgmentReadyWorkClaimResult = ({
  claimedCount,
  jobId,
  ownerBacked,
  providerKey,
  requestedCount,
}: {
  claimedCount: number
  jobId: string
  ownerBacked: boolean
  providerKey: string
  requestedCount: number
}): void => {
  if (!ownerBacked) {
    return
  }

  claimResultsByJobAndProvider.set(getClaimResultKey({jobId, providerKey}), {
    claimedCount: getNonNegativeInteger(claimedCount),
    jobId,
    providerKey,
    recordedAtMs: Date.now(),
    requestedCount: getNonNegativeInteger(requestedCount),
  })
}

export const getJudgmentReadyWorkSignal = ({
  jobId,
  ownerBacked,
  providerKey,
  readyCount,
}: JudgmentReadyWorkSignalInput): JudgmentReadyWorkSignal => {
  const normalizedReadyCount = getNonNegativeInteger(readyCount)

  if (!ownerBacked || (readyCount !== null && readyCount !== undefined && Number.isFinite(readyCount))) {
    return {readyCount: normalizedReadyCount, source: 'readyCount'}
  }

  const claimResult = getFreshClaimResult({jobId, nowMs: Date.now(), providerKey})

  if (claimResult && claimResult.requestedCount > 0 && claimResult.claimedCount === 0) {
    return {readyCount: 0, source: 'claimResultFallback'}
  }

  return claimResult && claimResult.claimedCount > 0
    ? {readyCount: claimResult.claimedCount, source: 'claimResultFallback'}
    : {readyCount: Number.MAX_SAFE_INTEGER, source: 'ownerBackedAssumedReady'}
}

export const resetJudgmentReadyWorkSignalForTests = (): void => {
  claimResultsByJobAndProvider.clear()
}

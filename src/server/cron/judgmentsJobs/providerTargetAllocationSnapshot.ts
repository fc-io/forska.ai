export type ProviderTargetAllocationInputState = 'completeCurrent' | 'partialTelemetry'

export type ProviderTargetAllocationSourceMetadata = {
  aggregateCompleteness: 'complete' | 'partial' | 'unavailable'
  freshWorkerCount: number
  staleWorkerCount: number
  unavailableWorkerCount: number
}

export type ProviderTargetAllocationIncompleteInput = {
  reason: 'partialTelemetry' | 'providerKeyMismatch' | 'staleProviderLimitVersion'
  workerId: string | null
}

export type ProviderTargetAllocationWorkerInput = {
  effectiveProviderLimit?: number | null
  localProviderLiveRequests?: number | null
  providerKey: string
  providerLimitVersion?: string | null
  routeable: boolean
  workerId: string
}

export type ProviderTargetAllocationWorkerSnapshot = {
  effectiveProviderLimit: number
  expectedLocalLiveShare: number
  localProviderLiveRequests: number
  providerKey: string
  providerLimitVersion: string | null
  routeable: boolean
  workerId: string
}

export type ProviderTargetAllocationSnapshot = {
  allocationCompleteCurrent: boolean
  allocationInputState: ProviderTargetAllocationInputState
  incompleteInputs: ProviderTargetAllocationIncompleteInput[]
  normalRequestCapacity: number
  probeOccupancySampledAtMs: number
  providerAllocationVersion: string
  providerAvailableRequestLeases: number
  providerKey: string
  providerLeasedLiveRequests: number
  providerLeasedPhysicalCalls: number
  providerLeasedProbeCalls: number
  providerLimit: number
  providerLimitVersion: string
  providerProbeOccupancyVersion: string
  source: ProviderTargetAllocationSourceMetadata
  targetRequestLiveCalls: number
  unallocatedTargetLiveCalls: number
  workers: ProviderTargetAllocationWorkerSnapshot[]
}

type AllocationCandidate = {effectiveProviderLimit: number; providerKey: string; workerId: string}

type AllocationState = {shares: Map<string, number>; unallocatedTargetLiveCalls: number}

export const getTargetRequestLiveCalls = (normalRequestCapacity: number): number => {
  return normalRequestCapacity <= 0
    ? 0
    : Math.max(1, Math.min(normalRequestCapacity, Math.ceil(normalRequestCapacity * 0.95)))
}

export const getProviderAllocationVersion = ({
  providerLimitVersion,
  providerProbeOccupancyVersion,
}: {
  providerLimitVersion: string
  providerProbeOccupancyVersion: string
}): string => {
  return `local:${providerLimitVersion}:${providerProbeOccupancyVersion}`
}

const getFiniteInteger = (value: number | null | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

const compareWorkerOrder = <T extends {providerKey: string; workerId: string}>(left: T, right: T): number => {
  const providerOrder = left.providerKey.localeCompare(right.providerKey)

  return providerOrder === 0 ? left.workerId.localeCompare(right.workerId) : providerOrder
}

const getWorkerRemainingCapacity = (candidate: AllocationCandidate, shares: Map<string, number>): number => {
  return Math.max(0, candidate.effectiveProviderLimit - (shares.get(candidate.workerId) ?? 0))
}

const allocateTargetShareRound = ({
  candidates,
  shares,
  target,
}: {
  candidates: AllocationCandidate[]
  shares: Map<string, number>
  target: number
}): AllocationState => {
  const activeCandidates = candidates.filter((candidate) => {
    return getWorkerRemainingCapacity(candidate, shares) > 0
  })
  const baseShare = activeCandidates.length === 0 ? 0 : Math.floor(target / activeCandidates.length)
  const remainderShare = activeCandidates.length === 0 ? 0 : target % activeCandidates.length

  return activeCandidates.reduce<AllocationState>(
    (state, candidate, index) => {
      const proposedShare = baseShare + (index < remainderShare ? 1 : 0)
      const nextShare = Math.min(proposedShare, getWorkerRemainingCapacity(candidate, state.shares))
      const sharesWithCandidate = new Map(state.shares)

      sharesWithCandidate.set(candidate.workerId, (sharesWithCandidate.get(candidate.workerId) ?? 0) + nextShare)

      return {shares: sharesWithCandidate, unallocatedTargetLiveCalls: state.unallocatedTargetLiveCalls - nextShare}
    },
    {shares, unallocatedTargetLiveCalls: target},
  )
}

const allocateTargetShares = ({
  candidates,
  shares = new Map<string, number>(),
  target,
}: {
  candidates: AllocationCandidate[]
  shares?: Map<string, number>
  target: number
}): AllocationState => {
  const activeCandidates = candidates.filter((candidate) => {
    return getWorkerRemainingCapacity(candidate, shares) > 0
  })
  const shouldStop = target <= 0 || activeCandidates.length === 0

  if (shouldStop) {
    return {shares, unallocatedTargetLiveCalls: Math.max(0, target)}
  }

  const round = allocateTargetShareRound({candidates: activeCandidates, shares, target})
  const noProgress = round.unallocatedTargetLiveCalls === target

  return noProgress
    ? round
    : allocateTargetShares({
        candidates: activeCandidates,
        shares: round.shares,
        target: round.unallocatedTargetLiveCalls,
      })
}

const getIncompleteInputs = ({
  source,
  workers,
  providerKey,
  providerLimitVersion,
}: {
  providerKey: string
  providerLimitVersion: string
  source: ProviderTargetAllocationSourceMetadata
  workers: ProviderTargetAllocationWorkerInput[]
}): ProviderTargetAllocationIncompleteInput[] => {
  const partialTelemetry =
    source.aggregateCompleteness === 'complete' ? [] : [{reason: 'partialTelemetry' as const, workerId: null}]
  const workerInputs = workers.flatMap((worker) => {
    const providerKeyMismatch = worker.providerKey === providerKey ? [] : ['providerKeyMismatch' as const]
    const staleProviderLimitVersion =
      worker.providerLimitVersion === null
      || worker.providerLimitVersion === undefined
      || worker.providerLimitVersion === providerLimitVersion
        ? []
        : ['staleProviderLimitVersion' as const]

    return [...providerKeyMismatch, ...staleProviderLimitVersion].map((reason) => {
      return {reason, workerId: worker.workerId}
    })
  })

  return [...partialTelemetry, ...workerInputs]
}

export const getProviderTargetAllocationSnapshot = ({
  probeOccupancySampledAtMs,
  providerKey,
  providerLeasedLiveRequests,
  providerLeasedProbeCalls,
  providerLimit,
  providerLimitVersion,
  providerProbeOccupancyVersion,
  source,
  workers,
}: {
  probeOccupancySampledAtMs: number
  providerKey: string
  providerLeasedLiveRequests: number
  providerLeasedProbeCalls: number
  providerLimit: number
  providerLimitVersion: string
  providerProbeOccupancyVersion: string
  source: ProviderTargetAllocationSourceMetadata
  workers: ProviderTargetAllocationWorkerInput[]
}): ProviderTargetAllocationSnapshot => {
  const normalizedProviderLimit = getFiniteInteger(providerLimit)
  const normalizedProviderLeasedLiveRequests = getFiniteInteger(providerLeasedLiveRequests)
  const normalizedProviderLeasedProbeCalls = getFiniteInteger(providerLeasedProbeCalls)
  const providerLeasedPhysicalCalls = normalizedProviderLeasedLiveRequests + normalizedProviderLeasedProbeCalls
  const providerAvailableRequestLeases = Math.max(0, normalizedProviderLimit - providerLeasedPhysicalCalls)
  const normalRequestCapacity = Math.max(0, normalizedProviderLimit - normalizedProviderLeasedProbeCalls)
  const targetRequestLiveCalls = getTargetRequestLiveCalls(normalRequestCapacity)
  const orderedWorkers = [...workers].sort(compareWorkerOrder)
  const incompleteInputs = getIncompleteInputs({providerKey, providerLimitVersion, source, workers: orderedWorkers})
  const allocationCompleteCurrent = incompleteInputs.length === 0
  const allocationInputState = allocationCompleteCurrent ? 'completeCurrent' : 'partialTelemetry'
  const routeableWorkers = orderedWorkers.flatMap((worker) => {
    const currentProvider = worker.providerKey === providerKey && worker.providerLimitVersion === providerLimitVersion
    const routeable = allocationCompleteCurrent && worker.routeable && currentProvider
    const effectiveProviderLimit = routeable
      ? Math.min(normalRequestCapacity, getFiniteInteger(worker.effectiveProviderLimit ?? normalRequestCapacity))
      : 0

    return routeable && effectiveProviderLimit > 0
      ? [{effectiveProviderLimit, providerKey: worker.providerKey, workerId: worker.workerId}]
      : []
  })
  const allocation = allocateTargetShares({candidates: routeableWorkers, target: targetRequestLiveCalls})
  const workerSnapshots = orderedWorkers.map<ProviderTargetAllocationWorkerSnapshot>((worker) => {
    const routeable = routeableWorkers.some((routeableWorker) => {
      return routeableWorker.workerId === worker.workerId
    })
    const effectiveProviderLimit = routeable
      ? (routeableWorkers.find((routeableWorker) => {
          return routeableWorker.workerId === worker.workerId
        })?.effectiveProviderLimit ?? 0)
      : 0

    return {
      effectiveProviderLimit,
      expectedLocalLiveShare: allocation.shares.get(worker.workerId) ?? 0,
      localProviderLiveRequests: getFiniteInteger(worker.localProviderLiveRequests),
      providerKey: worker.providerKey,
      providerLimitVersion: worker.providerLimitVersion ?? null,
      routeable,
      workerId: worker.workerId,
    }
  })

  return {
    allocationCompleteCurrent,
    allocationInputState,
    incompleteInputs,
    normalRequestCapacity,
    probeOccupancySampledAtMs: getFiniteInteger(probeOccupancySampledAtMs),
    providerAllocationVersion: getProviderAllocationVersion({providerLimitVersion, providerProbeOccupancyVersion}),
    providerAvailableRequestLeases,
    providerKey,
    providerLeasedLiveRequests: normalizedProviderLeasedLiveRequests,
    providerLeasedPhysicalCalls,
    providerLeasedProbeCalls: normalizedProviderLeasedProbeCalls,
    providerLimit: normalizedProviderLimit,
    providerLimitVersion,
    providerProbeOccupancyVersion,
    source,
    targetRequestLiveCalls,
    unallocatedTargetLiveCalls: allocation.unallocatedTargetLiveCalls,
    workers: workerSnapshots,
  }
}

export const getProviderTargetAllocationWorkerSnapshot = ({
  snapshot,
  workerId,
}: {
  snapshot: ProviderTargetAllocationSnapshot
  workerId: string
}): ProviderTargetAllocationWorkerSnapshot | null => {
  return (
    snapshot.workers.find((worker) => {
      return worker.workerId === workerId
    }) ?? null
  )
}

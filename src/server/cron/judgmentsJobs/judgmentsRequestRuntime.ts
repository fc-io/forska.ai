import {randomUUID} from 'node:crypto'

import {getProviderConnection} from '../../providers/providerConnectionRepository.ts'
import {testProviderConnectionHealth} from '../../providers/providerHealthService.ts'
import type {ProviderConnectionRecord} from '../../providers/providerTypes.ts'
import {workerLoadBalancer} from '../../utils/workerLoadBalancer.ts'
import {
  classifyConnectionFailure,
  ConnectionError,
  createConnectionError,
  parseConnectionFailureMessage,
  recordConnectionFailure,
  recordConnectionSuccess,
} from './connectionHealth.ts'
import {shouldSkipEndpointAvailabilityHttpProbe} from './endpointAvailabilityKey.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {shouldUseJudgeWorkerOwnerHandoff} from './judgeWorkerCompletionJournal.ts'
import {
  adjustJudgmentEndpointLocalProbeLiveCount,
  adjustJudgmentEndpointObservedAggregateProbeLiveCount,
  claimJudgmentEndpointAvailability,
  getJudgmentEndpointAvailability,
  resetJudgmentEndpointAvailabilityForTests,
  setJudgmentEndpointObservedAggregateProbeLiveCount,
} from './judgmentEndpointAvailability.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import type {
  JudgmentRequestAttemptLiveContext,
  JudgmentRequestAttemptManifestOwner,
  JudgmentRequestAttemptRuntimeContext,
} from './judgmentRequestAttemptManifest.ts'
import {recordRequestAttemptManifestStage} from './judgmentRequestAttemptManifestStore.ts'
import {
  acquireProviderAdmissionLeasePersisted,
  getProviderAdmissionProbeLeaseIdentity,
  getProviderAdmissionRequestLeaseIdentity,
  getProviderBucketSnapshot,
  type ProviderBucketSnapshot,
  releaseProviderAdmissionLeaseWithResultThroughOwner,
  resetProviderAdmissionLeaseForTests,
} from './providerAdmissionLease.ts'
import {getNormalizedProviderKeyProvider, getProviderKey} from './providerKey.ts'

type RequestSlot = {baseURL: string; release: () => void; requiresProbe: boolean}

type RequestWaiter<T> = {resolve: (value: T) => void; reject: (error: unknown) => void}

type ProviderRequestScope = {
  modelId?: string | null
  modelProvider?: string | null
  providerFamily?: string | null
  providerId?: string | null
  providerKey?: string | null
  providerConnectionId: string | null
  providerLimit?: number | null
  providerLimitVersion?: string | null
  providerMaxInflightRequests: number | null
  providerName?: string | null
  providerUsesFamilyDefault: boolean
  resolvedDefaultCapacity?: number | null
}
type ProviderAdmissionRetryWaiter = () => void
type CodexProviderWaiter = RequestWaiter<() => void> & {providerScope: ProviderRequestScope}
type FallbackWaiter = RequestWaiter<RequestSlot> & {baseURL: string; providerScope: ProviderRequestScope}
type WorkerWaiter = RequestWaiter<RequestSlot> & {providerScope: ProviderRequestScope; workerUrls: string[]}
type ProviderRequestAdmissionLease = {holderToken: string; leaseIdentity: string; providerKey: string}
type ProviderProbeAdmissionLease = ProviderRequestAdmissionLease & {
  endpointAvailabilityKey: string
  probeAttemptId: string
}

type JobRequestState = {inFlight: number; pendingRequestAttemptIds: Set<string>}
type ProviderRequestState = {inFlight: number}
type SlotAcquisitionAttempt = {slot: RequestSlot; type: 'slot'} | {type: 'blocked'} | {type: 'waiting'}
type ProbeAcquisitionTarget =
  | {baseURL: string; endpointAvailabilityKey: string; type: 'probe'}
  | {type: 'blocked'}
  | {type: 'healthy'}
  | {endpointAvailabilityKey: string; probePromise?: Promise<void> | null; retryAt?: Date | null; type: 'waiting'}
type ProbeAdmissionWaiter = {
  endpointAvailabilityKey: string | null
  reject: (error: unknown) => void
  resolve: () => void
  timeout: ReturnType<typeof setTimeout> | null
}
type RequestAttemptErrorCarrier = {
  providerKey?: string
  requestAttemptId?: string
  requestFinishedAt?: string
  requestStartedAt?: string
}

const codexWaiters: RequestWaiter<() => void>[] = []
const codexProviderWaiters: CodexProviderWaiter[] = []
const workerWaiters: WorkerWaiter[] = []
const fallbackWaiters: FallbackWaiter[] = []
const providerAdmissionRetryWaiters: ProviderAdmissionRetryWaiter[] = []
const probeAdmissionWaiters: ProbeAdmissionWaiter[] = []
const jobRequestStates = new Map<string, JobRequestState>()
const providerRequestStates = new Map<string, ProviderRequestState>()
const fallbackInFlightByProviderKey = new Map<string, number>()
const localEndpointProbePermits = new Set<string>()

let codexInFlight = 0
const providerAdmissionLeaseRetryDelayMs = 250

const normalizeProvider = (value: string | null | undefined): string => {
  return getNormalizedProviderKeyProvider(value)
}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

const getPositiveIntegerValue = (value: number | null | undefined): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : null
}

const getNonCodexCapacity = () => {
  return getJudgmentsCapacity(1)
}

const getProviderRequestKey = (providerScope: ProviderRequestScope): string => {
  return (
    providerScope.providerKey
    ?? getProviderKey({
      modelId: providerScope.modelId,
      modelProvider: providerScope.modelProvider,
      providerConnectionId: providerScope.providerConnectionId,
      useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
    })
  )
}

const getProviderRequestState = (providerKey: string): ProviderRequestState => {
  const existing = providerRequestStates.get(providerKey)
  if (existing) return existing

  const created = {inFlight: 0}
  providerRequestStates.set(providerKey, created)
  return created
}

const trimProviderRequestState = (providerKey: string): void => {
  const state = providerRequestStates.get(providerKey)
  if (state && state.inFlight === 0) {
    providerRequestStates.delete(providerKey)
  }
}

const acquireProviderRequestRelease = (providerScope: ProviderRequestScope): (() => void) | null => {
  const providerKey = getProviderRequestKey(providerScope)
  const maxInflight = providerScope.providerMaxInflightRequests

  if (maxInflight == null) {
    return () => {
      return undefined
    }
  }

  const state = getProviderRequestState(providerKey)
  const normalizedMaxInflight = Math.max(1, maxInflight)

  if (state.inFlight >= normalizedMaxInflight) {
    return null
  }

  state.inFlight += 1

  return () => {
    state.inFlight = Math.max(0, state.inFlight - 1)
    trimProviderRequestState(providerKey)
  }
}

const getJobRequestState = (judgmentsJobId: string): JobRequestState => {
  const existing = jobRequestStates.get(judgmentsJobId)
  if (existing) return existing

  const created = {inFlight: 0, pendingRequestAttemptIds: new Set<string>()}
  jobRequestStates.set(judgmentsJobId, created)
  return created
}

const trimJobRequestState = (judgmentsJobId: string): void => {
  const state = jobRequestStates.get(judgmentsJobId)
  if (state && state.inFlight === 0 && state.pendingRequestAttemptIds.size === 0) {
    jobRequestStates.delete(judgmentsJobId)
  }
}

const markRequestStarted = (judgmentsJobId: string, requestAttemptId: string): void => {
  const state = getJobRequestState(judgmentsJobId)
  state.inFlight += 1
  state.pendingRequestAttemptIds.add(requestAttemptId)
}

const markRequestFinished = (judgmentsJobId: string): void => {
  const state = getJobRequestState(judgmentsJobId)
  state.inFlight = Math.max(0, state.inFlight - 1)
  trimJobRequestState(judgmentsJobId)
}

const createRequestAttemptContext = (providerScope: ProviderRequestScope) => {
  return {
    createdAt: new Date().toISOString(),
    providerKey: getProviderRequestKey(providerScope),
    requestAttemptId: randomUUID(),
  }
}

const getCompleteProviderBucketSnapshot = (providerScope: ProviderRequestScope): ProviderBucketSnapshot | null => {
  const providerKey = getTrimmedValue(providerScope.providerKey)
  const providerLimitVersion = getTrimmedValue(providerScope.providerLimitVersion)
  const providerLimit = getPositiveIntegerValue(providerScope.providerLimit)
  const resolvedDefaultCapacity = getPositiveIntegerValue(providerScope.resolvedDefaultCapacity)
  const providerFamily = getTrimmedValue(providerScope.providerFamily)
  const providerId = getTrimmedValue(providerScope.providerId) ?? providerKey
  const providerName = getTrimmedValue(providerScope.providerName) ?? providerFamily

  return providerKey && providerLimitVersion && providerLimit && resolvedDefaultCapacity && providerFamily && providerId
    ? {
        maxInflightRequests: providerScope.providerUsesFamilyDefault ? null : providerScope.providerMaxInflightRequests,
        providerFamily,
        providerId,
        providerKey,
        providerLimit,
        providerLimitVersion,
        providerName: providerName ?? providerFamily,
        providerUsesFamilyDefault: providerScope.providerUsesFamilyDefault,
        resolvedDefaultCapacity,
      }
    : null
}

const getProviderAdmissionSnapshot = (providerScope: ProviderRequestScope): ProviderBucketSnapshot => {
  const completeSnapshot = getCompleteProviderBucketSnapshot(providerScope)

  if (completeSnapshot) {
    return completeSnapshot
  }

  return getProviderBucketSnapshot({
    maxInflightRequests: providerScope.providerUsesFamilyDefault ? null : providerScope.providerMaxInflightRequests,
    modelId: providerScope.modelId,
    modelProvider: providerScope.modelProvider,
    providerConnectionId: providerScope.providerConnectionId,
    providerName: providerScope.providerName,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
}

const getProviderRequestLeaseHolderToken = (requestAttemptId: string): string => {
  return `${getDefaultJudgmentServerJobId()}:request:${requestAttemptId}`
}

const getProviderProbeLeaseHolderToken = ({
  endpointAvailabilityKey,
  probeAttemptId,
}: {
  endpointAvailabilityKey: string
  probeAttemptId: string
}): string => {
  return `${getDefaultJudgmentServerJobId()}:probe:${endpointAvailabilityKey}:${probeAttemptId}`
}

const removeProviderAdmissionRetryWaiter = (waiter: ProviderAdmissionRetryWaiter): void => {
  const index = providerAdmissionRetryWaiters.indexOf(waiter)

  if (index >= 0) {
    providerAdmissionRetryWaiters.splice(index, 1)
  }
}

const waitForProviderAdmissionRetry = async (): Promise<void> => {
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const waiter = (): void => {
      if (timeout) {
        clearTimeout(timeout)
      }
      removeProviderAdmissionRetryWaiter(waiter)
      resolve()
    }

    timeout = setTimeout(waiter, providerAdmissionLeaseRetryDelayMs)
    providerAdmissionRetryWaiters.push(waiter)
  })
}

const notifyProviderAdmissionRetryWaiters = (): void => {
  providerAdmissionRetryWaiters.splice(0, providerAdmissionRetryWaiters.length).map((waiter) => {
    waiter()
    return waiter
  })
}

const removeProbeAdmissionWaiter = (waiter: ProbeAdmissionWaiter): void => {
  const index = probeAdmissionWaiters.indexOf(waiter)

  if (index >= 0) {
    probeAdmissionWaiters.splice(index, 1)
  }
}

const settleProbeAdmissionWaiter = (waiter: ProbeAdmissionWaiter): void => {
  if (waiter.timeout) {
    clearTimeout(waiter.timeout)
  }
  removeProbeAdmissionWaiter(waiter)
  waiter.resolve()
}

const rejectProbeAdmissionWaiter = (waiter: ProbeAdmissionWaiter, error: unknown): void => {
  if (waiter.timeout) {
    clearTimeout(waiter.timeout)
  }
  removeProbeAdmissionWaiter(waiter)
  waiter.reject(error)
}

const notifyProbeAdmissionWaiters = (endpointAvailabilityKey: string | null = null): void => {
  probeAdmissionWaiters
    .filter((waiter) => {
      return endpointAvailabilityKey === null || waiter.endpointAvailabilityKey === endpointAvailabilityKey
    })
    .map((waiter) => {
      settleProbeAdmissionWaiter(waiter)
      return waiter
    })
}

const waitForProbeAdmissionRetry = async ({
  endpointAvailabilityKey,
  probePromise = null,
  retryAt = null,
}: {
  endpointAvailabilityKey: string | null
  probePromise?: Promise<void> | null
  retryAt?: Date | null
}): Promise<void> => {
  return new Promise((resolve, reject) => {
    const retryDelayMs = retryAt ? Math.max(0, retryAt.getTime() - Date.now()) : providerAdmissionLeaseRetryDelayMs
    const waiter: ProbeAdmissionWaiter = {endpointAvailabilityKey, reject, resolve, timeout: null}

    waiter.timeout = setTimeout(() => {
      settleProbeAdmissionWaiter(waiter)
    }, retryDelayMs)
    probeAdmissionWaiters.push(waiter)
    probePromise?.then(
      () => {
        settleProbeAdmissionWaiter(waiter)
      },
      (error) => {
        rejectProbeAdmissionWaiter(waiter, error)
      },
    )
  })
}

const acquireProviderRequestAdmissionLease = async ({
  requestAttempt,
  snapshot,
}: {
  requestAttempt: JudgmentRequestAttemptRuntimeContext
  snapshot: ProviderBucketSnapshot
}): Promise<ProviderRequestAdmissionLease> => {
  const holderToken = getProviderRequestLeaseHolderToken(requestAttempt.requestAttemptId)
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity(requestAttempt.requestAttemptId)
  const result = await acquireProviderAdmissionLeasePersisted({
    holderToken,
    leaseIdentity,
    leaseKind: 'request',
    requestAttemptId: requestAttempt.requestAttemptId,
    snapshot,
  })

  if (result.acquired) {
    return {holderToken, leaseIdentity, providerKey: snapshot.providerKey}
  }

  if (result.reason === 'staleProviderLimitSnapshot') {
    return acquireProviderRequestAdmissionLease({requestAttempt, snapshot: result.currentSnapshot})
  }

  await waitForProviderAdmissionRetry()

  return acquireProviderRequestAdmissionLease({requestAttempt, snapshot: result.currentSnapshot})
}

const releaseProviderRequestAdmissionLease = async (lease: ProviderRequestAdmissionLease): Promise<void> => {
  await releaseProviderAdmissionLeaseWithResultThroughOwner(lease).catch(() => {
    return {reason: 'notHolder' as const, released: false as const}
  })
  notifyProviderAdmissionRetryWaiters()
  notifyProbeAdmissionWaiters()
}

const acquireProviderProbeAdmissionLease = async ({
  endpointAvailabilityKey,
  probeAttemptId,
  snapshot,
}: {
  endpointAvailabilityKey: string
  probeAttemptId: string
  snapshot: ProviderBucketSnapshot
}): Promise<ProviderProbeAdmissionLease> => {
  const holderToken = getProviderProbeLeaseHolderToken({endpointAvailabilityKey, probeAttemptId})
  const leaseIdentity = getProviderAdmissionProbeLeaseIdentity({endpointAvailabilityKey, probeAttemptId})
  const result = await acquireProviderAdmissionLeasePersisted({
    endpointAvailabilityKey,
    holderToken,
    leaseIdentity,
    leaseKind: 'probe',
    probeAttemptId,
    snapshot,
  })

  if (result.activeProbeLeaseCount !== undefined) {
    setJudgmentEndpointObservedAggregateProbeLiveCount({
      endpointAvailabilityKey,
      observedAggregateProbeLiveCount: result.activeProbeLeaseCount,
    })
  }

  if (result.acquired) {
    return {endpointAvailabilityKey, holderToken, leaseIdentity, probeAttemptId, providerKey: snapshot.providerKey}
  }

  if (result.reason === 'staleProviderLimitSnapshot') {
    return acquireProviderProbeAdmissionLease({
      endpointAvailabilityKey,
      probeAttemptId,
      snapshot: result.currentSnapshot,
    })
  }

  await waitForProbeAdmissionRetry({endpointAvailabilityKey})

  return acquireProviderProbeAdmissionLease({endpointAvailabilityKey, probeAttemptId, snapshot: result.currentSnapshot})
}

const releaseProviderProbeAdmissionLease = async (lease: ProviderProbeAdmissionLease): Promise<void> => {
  await releaseProviderAdmissionLeaseWithResultThroughOwner(lease).catch(() => {
    return {reason: 'notHolder' as const, released: false as const}
  })
  adjustJudgmentEndpointObservedAggregateProbeLiveCount({
    delta: -1,
    endpointAvailabilityKey: lease.endpointAvailabilityKey,
  })
  notifyProbeAdmissionWaiters(lease.endpointAvailabilityKey)
  notifyProviderAdmissionRetryWaiters()
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const attachRuntimeRequestAttemptFieldsToError = <T>(error: T, fields: RequestAttemptErrorCarrier): T => {
  if (typeof error === 'object' && error !== null) {
    Object.assign(error, fields)
  }

  return error
}

const getRuntimeRequestAttemptErrorFields = ({
  finishedAt,
  requestAttempt,
}: {
  finishedAt: string
  requestAttempt: JudgmentRequestAttemptRuntimeContext
}): RequestAttemptErrorCarrier => {
  const startedAt = (requestAttempt as {startedAt?: string}).startedAt ?? requestAttempt.createdAt

  return {
    providerKey: requestAttempt.providerKey,
    requestAttemptId: requestAttempt.requestAttemptId,
    requestFinishedAt: finishedAt,
    requestStartedAt: startedAt,
  }
}

const createProviderScopeConnectionContext = ({baseURL}: {baseURL: string}) => {
  return {effectiveBaseURL: baseURL, endpointPath: null, providerKind: null}
}

const getProviderProbeEndpointPath = (provider: string | null | undefined): string | null => {
  return normalizeProvider(provider) === 'codex' ? null : '/v1/models'
}

const getProbeFailure = ({
  baseURL,
  message,
  provider,
}: {
  baseURL: string
  message: string
  provider: string | null | undefined
}) => {
  const parsedFailure = parseConnectionFailureMessage(message)

  if (parsedFailure) {
    return parsedFailure
  }

  return classifyConnectionFailure({
    context: {
      effectiveBaseURL: baseURL,
      endpointPath: getProviderProbeEndpointPath(provider),
      providerKind: provider ?? null,
    },
    error: new Error(message),
  })
}

const acquireLocalProbePermit = (endpointAvailabilityKey: string): (() => void) | null => {
  if (localEndpointProbePermits.has(endpointAvailabilityKey)) {
    return null
  }

  localEndpointProbePermits.add(endpointAvailabilityKey)
  adjustJudgmentEndpointLocalProbeLiveCount({delta: 1, endpointAvailabilityKey})

  return () => {
    localEndpointProbePermits.delete(endpointAvailabilityKey)
    adjustJudgmentEndpointLocalProbeLiveCount({delta: -1, endpointAvailabilityKey})
    notifyProbeAdmissionWaiters(endpointAvailabilityKey)
  }
}

const getDefaultEndpointProbeUrl = (baseURL: string): string => {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

const probeDefaultEndpointAvailability = async ({
  baseURL,
  modelId,
  provider,
  providerKey,
}: {
  baseURL: string
  modelId?: string | null
  provider: string | null | undefined
  providerKey?: string | null
}): Promise<void> => {
  const endpointPath = getProviderProbeEndpointPath(provider)

  if (!endpointPath) {
    return undefined
  }

  try {
    const response = await fetch(getDefaultEndpointProbeUrl(baseURL), {signal: AbortSignal.timeout(10_000)})
    const failure = classifyConnectionFailure({
      context: {effectiveBaseURL: baseURL, endpointPath, providerKind: provider ?? null},
      error: {status: response.status},
    })

    if (failure.shouldPauseConnection) {
      recordConnectionFailure({effectiveBaseURL: baseURL, failure, modelId, modelProvider: provider, providerKey})
      throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
    }

    recordConnectionSuccess({effectiveBaseURL: baseURL, modelId, modelProvider: provider, providerKey})
    return undefined
  } catch (error) {
    if (error instanceof ConnectionError) {
      throw error
    }

    const failure = classifyConnectionFailure({
      context: {effectiveBaseURL: baseURL, endpointPath, providerKind: provider ?? null},
      error,
    })

    recordConnectionFailure({effectiveBaseURL: baseURL, failure, modelId, modelProvider: provider, providerKey})
    throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
  }
}

const probeJudgmentEndpointAvailability = async ({
  baseURL,
  modelId,
  provider,
  providerConnection,
  providerConnectionId,
  providerKey,
}: {
  baseURL: string
  modelId?: string | null
  provider: string | null | undefined
  providerConnection?: ProviderConnectionRecord | null
  providerConnectionId: string | null
  providerKey?: string | null
}): Promise<void> => {
  if (!providerConnectionId) {
    return shouldSkipEndpointAvailabilityHttpProbe({
      effectiveBaseURL: baseURL,
      modelId,
      modelProvider: provider,
      providerConnectionId,
      providerKey,
      useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
    })
      ? undefined
      : probeDefaultEndpointAvailability({baseURL, modelId, provider, providerKey})
  }

  const connection = providerConnection ?? (await getProviderConnection(providerConnectionId))

  if (!connection) {
    const failure = classifyConnectionFailure({
      context: {
        effectiveBaseURL: baseURL,
        endpointPath: getProviderProbeEndpointPath(provider),
        providerKind: provider ?? null,
      },
      error: new Error(`Provider connection ${providerConnectionId} not found for endpoint probe`),
    })

    recordConnectionFailure({
      effectiveBaseURL: baseURL,
      failure,
      modelId,
      modelProvider: provider,
      providerConnectionId,
      providerKey,
    })

    throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
  }

  const result = await testProviderConnectionHealth(connection, {effectiveBaseURL: baseURL})

  if (result.ok) {
    recordConnectionSuccess({
      effectiveBaseURL: baseURL,
      modelId,
      modelProvider: provider,
      providerConnectionId,
      providerKey,
    })
    return undefined
  }

  const failure = getProbeFailure({
    baseURL,
    message: result.lastError ?? 'Provider connection health probe failed',
    provider,
  })

  recordConnectionFailure({
    effectiveBaseURL: baseURL,
    failure,
    modelId,
    modelProvider: provider,
    providerConnectionId,
    providerKey,
  })

  throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
}

const buildWorkerCircuitError = ({
  providerScope: _providerScope,
  workerUrls,
}: {
  providerScope: ProviderRequestScope
  workerUrls: string[]
}): ConnectionError => {
  const firstWorker = workerUrls[0]
  const baseURL = firstWorker ? `${firstWorker}/v1` : 'worker://unavailable'

  return createConnectionError({
    context: createProviderScopeConnectionContext({baseURL}),
    error: new Error('All inference workers blocked by endpoint availability gate'),
  })
}

const getEndpointAvailabilityState = ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}) => {
  return getJudgmentEndpointAvailability({
    effectiveBaseURL: baseURL,
    modelId: providerScope.modelId,
    modelProvider: providerScope.modelProvider,
    providerConnectionId: providerScope.providerConnectionId,
    providerKey: providerScope.providerKey,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
}

const canRequestEndpointNow = ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): boolean => {
  const state = getEndpointAvailabilityState({baseURL, providerScope})
  const cooldownExpired = state.cooldownExpiresAt ? state.cooldownExpiresAt.getTime() <= Date.now() : false

  return state.status === 'healthy' || (state.status !== 'probing' && cooldownExpired)
}

const canStartNormalEndpointRequestNow = ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): boolean => {
  return getEndpointAvailabilityState({baseURL, providerScope}).status === 'healthy'
}

const claimEndpointAvailability = ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): boolean => {
  return claimJudgmentEndpointAvailability({
    effectiveBaseURL: baseURL,
    modelId: providerScope.modelId,
    modelProvider: providerScope.modelProvider,
    providerConnectionId: providerScope.providerConnectionId,
    providerKey: providerScope.providerKey,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
}

const hasHealthyWorker = ({
  providerScope,
  workerUrls,
}: {
  providerScope: ProviderRequestScope
  workerUrls: string[]
}): boolean => {
  return workerUrls.some((url) => {
    return canRequestEndpointNow({baseURL: `${url}/v1`, providerScope})
  })
}

const getWorkerMaxActiveRequests = (providerScope: ProviderRequestScope): number => {
  const runtimeLimit = getNonCodexCapacity().perWorkerMaxInflightRequests
  const providerLimit = Math.max(1, providerScope.providerMaxInflightRequests ?? 1)

  return providerScope.providerUsesFamilyDefault ? runtimeLimit : Math.max(runtimeLimit, providerLimit)
}

const drainCodexWaiters = (): void => {
  const waiter = codexWaiters[0]
  const maxInflight = getCodexMaxInflight()
  const canAcquire = Boolean(waiter) && codexInFlight < maxInflight

  if (waiter && canAcquire) {
    codexInFlight += 1
    codexWaiters.shift()
    waiter.resolve(() => {
      codexInFlight = Math.max(0, codexInFlight - 1)
      drainCodexWaiters()
    })
    drainCodexWaiters()
  }
}

const acquireCodexRelease = async (): Promise<() => void> => {
  const maxInflight = getCodexMaxInflight()
  const canAcquire = codexInFlight < maxInflight

  if (canAcquire) {
    codexInFlight += 1
    return () => {
      codexInFlight = Math.max(0, codexInFlight - 1)
      drainCodexWaiters()
    }
  }

  return new Promise((resolve, reject) => {
    codexWaiters.push({resolve, reject})
  })
}

const drainCodexProviderWaiters = (): void => {
  const nextAction = codexProviderWaiters.reduce<{index: number; release: () => void} | null>(
    (state, waiter, index) => {
      if (state) return state

      const release = acquireProviderRequestRelease(waiter.providerScope)
      return release ? {index, release} : null
    },
    null,
  )

  if (!nextAction) return

  const [waiter] = codexProviderWaiters.splice(nextAction.index, 1)
  if (!waiter) return

  waiter.resolve(() => {
    nextAction.release()
    drainProviderScopedWaiters()
  })
  drainCodexProviderWaiters()
}

const acquireCodexProviderRelease = async (providerScope: ProviderRequestScope): Promise<() => void> => {
  const release = acquireProviderRequestRelease(providerScope)
  if (release) {
    return () => {
      release()
      drainProviderScopedWaiters()
    }
  }

  return new Promise((resolve, reject) => {
    codexProviderWaiters.push({providerScope, reject, resolve})
  })
}

const acquireCodexRequestRelease = async (providerScope: ProviderRequestScope): Promise<() => void> => {
  return getProviderRequestKey(providerScope) === 'codex:default'
    ? acquireCodexRelease()
    : acquireCodexProviderRelease(providerScope)
}

const drainProviderScopedWaiters = (): void => {
  drainCodexProviderWaiters()
  drainWorkerWaiters()
  drainFallbackWaiters()
}

const buildWorkerSlot = ({
  releaseProviderRequest,
  requiresProbe,
  workerUrl,
}: {
  releaseProviderRequest: () => void
  requiresProbe: boolean
  workerUrl: string
}): RequestSlot => {
  return {
    baseURL: `${workerUrl}/v1`,
    release: () => {
      workerLoadBalancer.releaseWorker(workerUrl)
      releaseProviderRequest()
      drainProviderScopedWaiters()
    },
    requiresProbe,
  }
}

const tryAcquireWorkerSlot = ({
  providerScope,
  workerUrls,
}: {
  providerScope: ProviderRequestScope
  workerUrls: string[]
}): SlotAcquisitionAttempt => {
  const releaseProviderRequest = acquireProviderRequestRelease(providerScope)
  if (!releaseProviderRequest) return {type: 'waiting'}

  const maxActiveRequests = getWorkerMaxActiveRequests(providerScope)
  const healthyWorkerUrl = workerLoadBalancer.acquireWorkerUrl({
    maxActiveRequests,
    workerUrls: workerUrls.filter((url) => {
      return getEndpointAvailabilityState({baseURL: `${url}/v1`, providerScope}).status === 'healthy'
    }),
  })

  if (healthyWorkerUrl) {
    return {
      slot: buildWorkerSlot({releaseProviderRequest, requiresProbe: false, workerUrl: healthyWorkerUrl}),
      type: 'slot',
    }
  }

  releaseProviderRequest()
  return hasHealthyWorker({providerScope, workerUrls}) ? {type: 'waiting'} : {type: 'blocked'}
}

const drainWorkerWaiters = (): void => {
  const nextAction = workerWaiters.reduce<
    {error: ConnectionError; index: number; type: 'reject'} | {index: number; slot: RequestSlot; type: 'resolve'} | null
  >((state, waiter, index) => {
    if (state) return state

    if (!hasHealthyWorker({providerScope: waiter.providerScope, workerUrls: waiter.workerUrls})) {
      return {
        error: buildWorkerCircuitError({providerScope: waiter.providerScope, workerUrls: waiter.workerUrls}),
        index,
        type: 'reject',
      }
    }

    const attempt = tryAcquireWorkerSlot(waiter)
    return attempt.type === 'slot'
      ? {index, slot: attempt.slot, type: 'resolve'}
      : attempt.type === 'blocked'
        ? {
            error: buildWorkerCircuitError({providerScope: waiter.providerScope, workerUrls: waiter.workerUrls}),
            index,
            type: 'reject',
          }
        : null
  }, null)

  if (!nextAction) return

  const [waiter] = workerWaiters.splice(nextAction.index, 1)
  if (!waiter) return

  return nextAction.type === 'resolve'
    ? (waiter.resolve(nextAction.slot), drainWorkerWaiters())
    : (waiter.reject(nextAction.error), drainWorkerWaiters())
}

const acquireWorkerSlot = async ({
  providerScope,
  workerUrls,
}: {
  providerScope: ProviderRequestScope
  workerUrls: string[]
}): Promise<RequestSlot> => {
  const attempt = tryAcquireWorkerSlot({providerScope, workerUrls})

  if (attempt.type === 'slot') return attempt.slot
  if (attempt.type === 'blocked') throw buildWorkerCircuitError({providerScope, workerUrls})

  return new Promise((resolve, reject) => {
    workerWaiters.push({providerScope, reject, resolve, workerUrls})
  })
}

const usesSharedFallbackCapacity = (providerScope: ProviderRequestScope): boolean => {
  return providerScope.providerUsesFamilyDefault || !providerScope.providerConnectionId
}

const getFallbackInFlight = (providerScope: ProviderRequestScope): number => {
  return fallbackInFlightByProviderKey.get(getProviderRequestKey(providerScope)) ?? 0
}

const incrementFallbackInFlight = (providerScope: ProviderRequestScope): void => {
  const providerKey = getProviderRequestKey(providerScope)
  fallbackInFlightByProviderKey.set(providerKey, getFallbackInFlight(providerScope) + 1)
}

const releaseFallbackInFlight = (providerScope: ProviderRequestScope): void => {
  const providerKey = getProviderRequestKey(providerScope)
  const nextInFlight = Math.max(0, getFallbackInFlight(providerScope) - 1)

  if (nextInFlight === 0) {
    fallbackInFlightByProviderKey.delete(providerKey)
    return
  }

  fallbackInFlightByProviderKey.set(providerKey, nextInFlight)
}

const tryAcquireFallbackSlot = ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): SlotAcquisitionAttempt => {
  const releaseProviderRequest = acquireProviderRequestRelease(providerScope)
  const useSharedCapacity = usesSharedFallbackCapacity(providerScope)
  const canAcquireFallback = useSharedCapacity
    ? getFallbackInFlight(providerScope) < getNonCodexCapacity().maxInflight
    : true

  if (!releaseProviderRequest || !canAcquireFallback) {
    return releaseProviderRequest ? (releaseProviderRequest(), {type: 'waiting'}) : {type: 'waiting'}
  }

  if (getEndpointAvailabilityState({baseURL, providerScope}).status !== 'healthy') {
    releaseProviderRequest()
    return {type: 'blocked'}
  }

  if (useSharedCapacity) {
    incrementFallbackInFlight(providerScope)
  }

  return {
    slot: {
      baseURL,
      release: () => {
        if (useSharedCapacity) {
          releaseFallbackInFlight(providerScope)
        }
        releaseProviderRequest()
        drainProviderScopedWaiters()
      },
      requiresProbe: false,
    },
    type: 'slot',
  }
}

const buildFallbackCircuitError = ({
  baseURL,
  providerScope: _providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): ConnectionError => {
  return createConnectionError({
    context: createProviderScopeConnectionContext({baseURL}),
    error: new Error('Inference server blocked by endpoint availability gate'),
  })
}

const getProbeEndpointBaseURLs = ({
  fallbackBaseURL,
  workerUrls,
}: {
  fallbackBaseURL: string
  workerUrls: string[]
}): string[] => {
  return workerUrls.length > 0
    ? workerUrls.map((workerUrl) => {
        return `${workerUrl}/v1`
      })
    : [fallbackBaseURL]
}

const getEndpointProbeTarget = ({
  fallbackBaseURL,
  providerScope,
  workerUrls,
}: {
  fallbackBaseURL: string
  providerScope: ProviderRequestScope
  workerUrls: string[]
}): ProbeAcquisitionTarget => {
  const endpointStates = getProbeEndpointBaseURLs({fallbackBaseURL, workerUrls}).map((baseURL) => {
    const availability = getEndpointAvailabilityState({baseURL, providerScope})
    return {availability, baseURL, endpointAvailabilityKey: availability.endpointAvailabilityKey}
  })
  const healthyEndpoint = endpointStates.find((state) => {
    return state.availability.status === 'healthy'
  })
  const probeEndpoint = endpointStates.find((state) => {
    return canRequestEndpointNow({baseURL: state.baseURL, providerScope})
  })
  const probingEndpoint = endpointStates.find((state) => {
    return state.availability.status === 'probing'
  })

  return healthyEndpoint
    ? {type: 'healthy'}
    : probeEndpoint
      ? {baseURL: probeEndpoint.baseURL, endpointAvailabilityKey: probeEndpoint.endpointAvailabilityKey, type: 'probe'}
      : probingEndpoint
        ? {
            endpointAvailabilityKey: probingEndpoint.endpointAvailabilityKey,
            probePromise: probingEndpoint.availability.probePromise,
            type: 'waiting',
          }
        : {type: 'blocked'}
}

const acquireEndpointProbeAdmission = async ({
  endpointAvailabilityKey,
  snapshot,
}: {
  endpointAvailabilityKey: string
  snapshot: ProviderBucketSnapshot
}): Promise<{lease: ProviderProbeAdmissionLease; releaseLocalPermit: () => void} | null> => {
  const probeAttemptId = randomUUID()
  const lease = await acquireProviderProbeAdmissionLease({endpointAvailabilityKey, probeAttemptId, snapshot})
  const releaseLocalPermit = acquireLocalProbePermit(endpointAvailabilityKey)

  if (releaseLocalPermit) {
    return {lease, releaseLocalPermit}
  }

  await releaseProviderProbeAdmissionLease(lease)
  await waitForProbeAdmissionRetry({endpointAvailabilityKey})

  return acquireEndpointProbeAdmission({endpointAvailabilityKey, snapshot})
}

const runEndpointRecoveryProbe = async ({
  baseURL,
  endpointAvailabilityKey,
  modelId,
  provider,
  providerConnection,
  providerConnectionId,
  providerScope,
  snapshot,
}: {
  baseURL: string
  endpointAvailabilityKey: string
  modelId?: string | null
  provider: string | null | undefined
  providerConnection?: ProviderConnectionRecord | null
  providerConnectionId: string | null
  providerScope: ProviderRequestScope
  snapshot: ProviderBucketSnapshot
}): Promise<boolean> => {
  const admission = await acquireEndpointProbeAdmission({endpointAvailabilityKey, snapshot})

  if (!admission) {
    return false
  }

  const claimed = claimEndpointAvailability({baseURL, providerScope})

  try {
    if (!claimed) {
      return false
    }

    await probeJudgmentEndpointAvailability({
      baseURL,
      modelId,
      provider,
      providerConnection,
      providerConnectionId,
      providerKey: snapshot.providerKey,
    })
    notifyProbeAdmissionWaiters(endpointAvailabilityKey)
    drainProviderScopedWaiters()
    return true
  } finally {
    admission.releaseLocalPermit()
    await releaseProviderProbeAdmissionLease(admission.lease)
  }
}

const recoverEndpointAvailabilityBeforeRequest = async ({
  fallbackBaseURL,
  modelId,
  provider,
  providerConnection,
  providerConnectionId,
  providerScope,
  snapshot,
  workerUrls,
}: {
  fallbackBaseURL: string
  modelId?: string | null
  provider: string | null | undefined
  providerConnection?: ProviderConnectionRecord | null
  providerConnectionId: string | null
  providerScope: ProviderRequestScope
  snapshot: ProviderBucketSnapshot
  workerUrls: string[]
}): Promise<void> => {
  if (normalizeProvider(provider) === 'codex') {
    return undefined
  }

  const target = getEndpointProbeTarget({fallbackBaseURL, providerScope, workerUrls})

  if (target.type === 'healthy') {
    return undefined
  }

  if (target.type === 'waiting') {
    await waitForProbeAdmissionRetry({
      endpointAvailabilityKey: target.endpointAvailabilityKey,
      probePromise: target.probePromise,
      retryAt: target.retryAt,
    })
    return recoverEndpointAvailabilityBeforeRequest({
      fallbackBaseURL,
      modelId,
      provider,
      providerConnection,
      providerConnectionId,
      providerScope,
      snapshot,
      workerUrls,
    })
  }

  if (target.type === 'blocked') {
    throw workerUrls.length > 0
      ? buildWorkerCircuitError({providerScope, workerUrls})
      : buildFallbackCircuitError({baseURL: fallbackBaseURL, providerScope})
  }

  await runEndpointRecoveryProbe({
    baseURL: target.baseURL,
    endpointAvailabilityKey: target.endpointAvailabilityKey,
    modelId,
    provider,
    providerConnection,
    providerConnectionId,
    providerScope,
    snapshot,
  })

  return recoverEndpointAvailabilityBeforeRequest({
    fallbackBaseURL,
    modelId,
    provider,
    providerConnection,
    providerConnectionId,
    providerScope,
    snapshot,
    workerUrls,
  })
}

const drainFallbackWaiters = (): void => {
  const nextAction = fallbackWaiters.reduce<
    {error: ConnectionError; index: number; type: 'reject'} | {index: number; slot: RequestSlot; type: 'resolve'} | null
  >((state, waiter, index) => {
    if (state) return state

    if (!canStartNormalEndpointRequestNow({baseURL: waiter.baseURL, providerScope: waiter.providerScope})) {
      return {error: buildFallbackCircuitError(waiter), index, type: 'reject'}
    }

    const attempt = tryAcquireFallbackSlot(waiter)
    return attempt.type === 'slot'
      ? {index, slot: attempt.slot, type: 'resolve'}
      : attempt.type === 'blocked'
        ? {error: buildFallbackCircuitError(waiter), index, type: 'reject'}
        : null
  }, null)

  if (!nextAction) return

  const [waiter] = fallbackWaiters.splice(nextAction.index, 1)
  if (!waiter) return

  return nextAction.type === 'resolve'
    ? (waiter.resolve(nextAction.slot), drainFallbackWaiters())
    : (waiter.reject(nextAction.error), drainFallbackWaiters())
}

const acquireFallbackSlot = async ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): Promise<RequestSlot> => {
  if (!canStartNormalEndpointRequestNow({baseURL, providerScope})) {
    throw buildFallbackCircuitError({baseURL, providerScope})
  }

  const attempt = tryAcquireFallbackSlot({baseURL, providerScope})
  if (attempt.type === 'slot') return attempt.slot
  if (attempt.type === 'blocked') throw buildFallbackCircuitError({baseURL, providerScope})

  return new Promise((resolve, reject) => {
    fallbackWaiters.push({baseURL, providerScope, resolve, reject})
  })
}

const acquireRequestSlot = async ({
  provider,
  fallbackBaseURL,
  modelId,
  providerKey,
  providerConnectionId,
  providerLimitVersion,
  providerMaxInflightRequests,
  providerUsesFamilyDefault,
  workerUrls,
}: {
  provider: string | null | undefined
  fallbackBaseURL: string
  modelId?: string | null
  providerConnectionId: string | null
  providerKey?: string | null
  providerLimitVersion?: string | null
  providerMaxInflightRequests: number | null
  providerUsesFamilyDefault: boolean
  workerUrls: string[]
}): Promise<RequestSlot> => {
  const providerScope = {
    modelId,
    modelProvider: provider,
    providerKey,
    providerConnectionId,
    providerLimitVersion,
    providerMaxInflightRequests,
    providerUsesFamilyDefault,
  }

  return normalizeProvider(provider) === 'codex'
    ? acquireCodexRequestRelease(providerScope).then((release) => {
        return {baseURL: fallbackBaseURL, release, requiresProbe: false}
      })
    : workerUrls.length > 0
      ? acquireWorkerSlot({providerScope, workerUrls})
      : acquireFallbackSlot({baseURL: fallbackBaseURL, providerScope})
}

export const getJudgmentRequestStats = (
  judgmentsJobId: string,
): {inFlight: number; pendingPersistedAttempts: number} => {
  const state = jobRequestStates.get(judgmentsJobId) ?? {inFlight: 0, pendingRequestAttemptIds: new Set<string>()}
  return {inFlight: state.inFlight, pendingPersistedAttempts: state.pendingRequestAttemptIds.size}
}

export const markJudgmentRequestAttemptsPersisted = (judgmentsJobId: string, requestAttemptIds: string[]): void => {
  const state = getJobRequestState(judgmentsJobId)

  requestAttemptIds.reduce((currentState, requestAttemptId) => {
    currentState.pendingRequestAttemptIds.delete(requestAttemptId)
    return currentState
  }, state)

  trimJobRequestState(judgmentsJobId)
}

export const markJudgmentRequestAttemptsClosed = (judgmentsJobId: string, requestAttemptIds: string[]): void => {
  markJudgmentRequestAttemptsPersisted(judgmentsJobId, requestAttemptIds)
}

export const withJudgmentRequest = async <T>(
  {
    judgmentsJobId,
    provider,
    fallbackBaseURL,
    modelId,
    providerKey,
    providerFamily,
    providerId,
    providerLimit,
    providerConnectionId,
    providerLimitVersion,
    providerMaxInflightRequests,
    providerName,
    providerUsesFamilyDefault,
    resolvedDefaultCapacity,
    providerConnection,
    requestAttemptManifestOwner,
    workerUrls,
  }: {
    judgmentsJobId: string
    provider: string | null | undefined
    fallbackBaseURL: string
    modelId?: string | null
    providerConnectionId: string | null
    providerKey?: string | null
    providerFamily?: string | null
    providerId?: string | null
    providerLimit?: number | null
    providerLimitVersion?: string | null
    providerConnection?: ProviderConnectionRecord | null
    providerMaxInflightRequests: number | null
    providerName?: string | null
    providerUsesFamilyDefault: boolean
    resolvedDefaultCapacity?: number | null
    requestAttemptManifestOwner?: JudgmentRequestAttemptManifestOwner | null
    workerUrls: string[]
  },
  run: (baseURL: string, requestAttempt: JudgmentRequestAttemptLiveContext) => Promise<T>,
): Promise<T> => {
  const providerScope = {
    modelId,
    modelProvider: provider,
    providerKey,
    providerFamily,
    providerId,
    providerLimit,
    providerConnectionId,
    providerLimitVersion,
    providerMaxInflightRequests,
    providerName,
    providerUsesFamilyDefault,
    resolvedDefaultCapacity,
  }
  const providerAdmissionSnapshot = getProviderAdmissionSnapshot(providerScope)

  await recoverEndpointAvailabilityBeforeRequest({
    fallbackBaseURL,
    modelId,
    provider,
    providerConnection,
    providerConnectionId,
    providerScope,
    snapshot: providerAdmissionSnapshot,
    workerUrls,
  })

  const requestAttemptContext = createRequestAttemptContext(providerScope)
  await recordRequestAttemptManifestStage({
    closeoutKind: 'slot_wait',
    owner: requestAttemptManifestOwner,
    requestAttempt: requestAttemptContext,
  })
  const providerAdmissionLease = await acquireProviderRequestAdmissionLease({
    requestAttempt: requestAttemptContext,
    snapshot: providerAdmissionSnapshot,
  }).catch(async (error) => {
    const finishedAt = new Date().toISOString()
    await recordRequestAttemptManifestStage({
      closeoutKind: 'slot_wait',
      error: getErrorMessage(error),
      finishedAt,
      outcome: 'failure',
      owner: requestAttemptManifestOwner,
      requestAttempt: requestAttemptContext,
    })
    throw attachRuntimeRequestAttemptFieldsToError(
      error,
      getRuntimeRequestAttemptErrorFields({finishedAt, requestAttempt: requestAttemptContext}),
    )
  })
  const slot = await acquireRequestSlot({
    fallbackBaseURL,
    modelId,
    provider,
    providerConnectionId,
    providerKey,
    providerLimitVersion,
    providerMaxInflightRequests,
    providerUsesFamilyDefault,
    workerUrls,
  }).catch(async (error) => {
    await releaseProviderRequestAdmissionLease(providerAdmissionLease)
    const finishedAt = new Date().toISOString()
    await recordRequestAttemptManifestStage({
      closeoutKind: 'slot_wait',
      error: getErrorMessage(error),
      finishedAt,
      outcome: 'failure',
      owner: requestAttemptManifestOwner,
      requestAttempt: requestAttemptContext,
    })
    throw attachRuntimeRequestAttemptFieldsToError(
      error,
      getRuntimeRequestAttemptErrorFields({finishedAt, requestAttempt: requestAttemptContext}),
    )
  })
  markRequestStarted(judgmentsJobId, requestAttemptContext.requestAttemptId)

  try {
    const requestAttempt = {...requestAttemptContext, baseURL: slot.baseURL, startedAt: new Date().toISOString()}
    await recordRequestAttemptManifestStage({
      baseURL: slot.baseURL,
      closeoutKind: 'live_request',
      owner: requestAttemptManifestOwner,
      requestAttempt,
      startedAt: requestAttempt.startedAt,
    })

    return await run(slot.baseURL, requestAttempt)
  } finally {
    markRequestFinished(judgmentsJobId)
    slot.release()
    await releaseProviderRequestAdmissionLease(providerAdmissionLease)
  }
}

export const resetJudgmentRequestRuntimeForTests = (): void => {
  codexWaiters.splice(0, codexWaiters.length)
  codexProviderWaiters.splice(0, codexProviderWaiters.length)
  workerWaiters.splice(0, workerWaiters.length)
  fallbackWaiters.splice(0, fallbackWaiters.length)
  providerAdmissionRetryWaiters.splice(0, providerAdmissionRetryWaiters.length)
  const waiters = probeAdmissionWaiters.slice()
  waiters.map((waiter) => {
    rejectProbeAdmissionWaiter(waiter, new Error('Judgment request runtime reset'))
    return waiter
  })
  jobRequestStates.clear()
  providerRequestStates.clear()
  fallbackInFlightByProviderKey.clear()
  localEndpointProbePermits.clear()
  codexInFlight = 0
  resetJudgmentEndpointAvailabilityForTests()
  resetProviderAdmissionLeaseForTests()
}

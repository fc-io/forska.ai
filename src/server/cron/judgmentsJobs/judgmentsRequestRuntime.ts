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
  claimJudgmentEndpointAvailability,
  getJudgmentEndpointAvailability,
  resetJudgmentEndpointAvailabilityForTests,
} from './judgmentEndpointAvailability.ts'
import type {JudgmentRequestAttemptLiveContext} from './judgmentRequestAttemptManifest.ts'
import {getNormalizedProviderKeyProvider, getProviderKey} from './providerKey.ts'

type RequestSlot = {baseURL: string; release: () => void; requiresProbe: boolean}

type RequestWaiter<T> = {resolve: (value: T) => void; reject: (error: unknown) => void}

type ProviderRequestScope = {
  modelId?: string | null
  modelProvider?: string | null
  providerKey?: string | null
  providerConnectionId: string | null
  providerLimitVersion?: string | null
  providerMaxInflightRequests: number | null
  providerUsesFamilyDefault: boolean
}
type CodexProviderWaiter = RequestWaiter<() => void> & {providerScope: ProviderRequestScope}
type FallbackWaiter = RequestWaiter<RequestSlot> & {baseURL: string; providerScope: ProviderRequestScope}
type WorkerWaiter = RequestWaiter<RequestSlot> & {providerScope: ProviderRequestScope; workerUrls: string[]}

type JobRequestState = {inFlight: number; pendingPersistedAttempts: number}
type ProviderRequestState = {inFlight: number}
type SlotAcquisitionAttempt = {slot: RequestSlot; type: 'slot'} | {type: 'blocked'} | {type: 'waiting'}

const codexWaiters: RequestWaiter<() => void>[] = []
const codexProviderWaiters: CodexProviderWaiter[] = []
const workerWaiters: WorkerWaiter[] = []
const fallbackWaiters: FallbackWaiter[] = []
const jobRequestStates = new Map<string, JobRequestState>()
const providerRequestStates = new Map<string, ProviderRequestState>()
const fallbackInFlightByProviderKey = new Map<string, number>()

let codexInFlight = 0

const normalizeProvider = (value: string | null | undefined): string => {
  return getNormalizedProviderKeyProvider(value)
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

  const created = {inFlight: 0, pendingPersistedAttempts: 0}
  jobRequestStates.set(judgmentsJobId, created)
  return created
}

const trimJobRequestState = (judgmentsJobId: string): void => {
  const state = jobRequestStates.get(judgmentsJobId)
  if (state && state.inFlight === 0 && state.pendingPersistedAttempts === 0) {
    jobRequestStates.delete(judgmentsJobId)
  }
}

const markRequestStarted = (judgmentsJobId: string): void => {
  const state = getJobRequestState(judgmentsJobId)
  state.inFlight += 1
  state.pendingPersistedAttempts += 1
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

const getDefaultEndpointProbeUrl = (baseURL: string): string => {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

const probeDefaultEndpointAvailability = async ({
  baseURL,
  modelId,
  provider,
}: {
  baseURL: string
  modelId?: string | null
  provider: string | null | undefined
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
      recordConnectionFailure({effectiveBaseURL: baseURL, failure, modelId, modelProvider: provider})
      throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
    }

    recordConnectionSuccess({effectiveBaseURL: baseURL, modelId, modelProvider: provider})
    return undefined
  } catch (error) {
    if (error instanceof ConnectionError) {
      throw error
    }

    const failure = classifyConnectionFailure({
      context: {effectiveBaseURL: baseURL, endpointPath, providerKind: provider ?? null},
      error,
    })

    recordConnectionFailure({effectiveBaseURL: baseURL, failure, modelId, modelProvider: provider})
    throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
  }
}

const probeJudgmentEndpointAvailability = async ({
  baseURL,
  modelId,
  provider,
  providerConnection,
  providerConnectionId,
}: {
  baseURL: string
  modelId?: string | null
  provider: string | null | undefined
  providerConnection?: ProviderConnectionRecord | null
  providerConnectionId: string | null
}): Promise<void> => {
  if (!providerConnectionId) {
    return shouldSkipEndpointAvailabilityHttpProbe({
      effectiveBaseURL: baseURL,
      modelId,
      modelProvider: provider,
      providerConnectionId,
      useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
    })
      ? undefined
      : probeDefaultEndpointAvailability({baseURL, modelId, provider})
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
    })

    throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
  }

  const result = await testProviderConnectionHealth(connection, {effectiveBaseURL: baseURL})

  if (result.ok) {
    recordConnectionSuccess({effectiveBaseURL: baseURL, modelId, modelProvider: provider, providerConnectionId})
    return undefined
  }

  const failure = getProbeFailure({
    baseURL,
    message: result.lastError ?? 'Provider connection health probe failed',
    provider,
  })

  recordConnectionFailure({effectiveBaseURL: baseURL, failure, modelId, modelProvider: provider, providerConnectionId})

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

  const probeEligibleWorkerUrl = workerLoadBalancer.acquireWorkerUrl({
    maxActiveRequests,
    workerUrls: workerUrls.filter((url) => {
      return canRequestEndpointNow({baseURL: `${url}/v1`, providerScope})
    }),
  })

  if (!probeEligibleWorkerUrl) {
    releaseProviderRequest()
    return hasHealthyWorker({providerScope, workerUrls}) ? {type: 'waiting'} : {type: 'blocked'}
  }

  const baseURL = `${probeEligibleWorkerUrl}/v1`

  if (!claimEndpointAvailability({baseURL, providerScope})) {
    workerLoadBalancer.releaseWorker(probeEligibleWorkerUrl)
    releaseProviderRequest()

    return hasHealthyWorker({providerScope, workerUrls}) ? {type: 'waiting'} : {type: 'blocked'}
  }

  return {
    slot: buildWorkerSlot({releaseProviderRequest, requiresProbe: true, workerUrl: probeEligibleWorkerUrl}),
    type: 'slot',
  }
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

  const requiresProbe = getEndpointAvailabilityState({baseURL, providerScope}).status !== 'healthy'

  if (!claimEndpointAvailability({baseURL, providerScope})) {
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
      requiresProbe,
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

const drainFallbackWaiters = (): void => {
  const nextAction = fallbackWaiters.reduce<
    {error: ConnectionError; index: number; type: 'reject'} | {index: number; slot: RequestSlot; type: 'resolve'} | null
  >((state, waiter, index) => {
    if (state) return state

    if (!canRequestEndpointNow({baseURL: waiter.baseURL, providerScope: waiter.providerScope})) {
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
  if (!canRequestEndpointNow({baseURL, providerScope})) {
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
  const state = jobRequestStates.get(judgmentsJobId) ?? {inFlight: 0, pendingPersistedAttempts: 0}
  return {inFlight: state.inFlight, pendingPersistedAttempts: state.pendingPersistedAttempts}
}

export const markJudgmentRequestsPersisted = (judgmentsJobId: string, count: number): void => {
  const state = getJobRequestState(judgmentsJobId)
  state.pendingPersistedAttempts = Math.max(0, state.pendingPersistedAttempts - Math.max(0, count))
  trimJobRequestState(judgmentsJobId)
}

export const withJudgmentRequest = async <T>(
  {
    judgmentsJobId,
    provider,
    fallbackBaseURL,
    modelId,
    providerKey,
    providerConnectionId,
    providerLimitVersion,
    providerMaxInflightRequests,
    providerUsesFamilyDefault,
    providerConnection,
    workerUrls,
  }: {
    judgmentsJobId: string
    provider: string | null | undefined
    fallbackBaseURL: string
    modelId?: string | null
    providerConnectionId: string | null
    providerKey?: string | null
    providerLimitVersion?: string | null
    providerConnection?: ProviderConnectionRecord | null
    providerMaxInflightRequests: number | null
    providerUsesFamilyDefault: boolean
    workerUrls: string[]
  },
  run: (baseURL: string, requestAttempt: JudgmentRequestAttemptLiveContext) => Promise<T>,
): Promise<T> => {
  const providerScope = {
    modelId,
    modelProvider: provider,
    providerKey,
    providerConnectionId,
    providerLimitVersion,
    providerMaxInflightRequests,
    providerUsesFamilyDefault,
  }
  const requestAttemptContext = createRequestAttemptContext(providerScope)
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
  })
  markRequestStarted(judgmentsJobId)

  try {
    const requestAttempt = {...requestAttemptContext, baseURL: slot.baseURL, startedAt: new Date().toISOString()}

    if (slot.requiresProbe) {
      await probeJudgmentEndpointAvailability({
        baseURL: slot.baseURL,
        modelId,
        provider,
        providerConnection,
        providerConnectionId,
      })
    }

    return await run(slot.baseURL, requestAttempt)
  } finally {
    markRequestFinished(judgmentsJobId)
    slot.release()
  }
}

export const resetJudgmentRequestRuntimeForTests = (): void => {
  codexWaiters.splice(0, codexWaiters.length)
  codexProviderWaiters.splice(0, codexProviderWaiters.length)
  workerWaiters.splice(0, workerWaiters.length)
  fallbackWaiters.splice(0, fallbackWaiters.length)
  jobRequestStates.clear()
  providerRequestStates.clear()
  fallbackInFlightByProviderKey.clear()
  codexInFlight = 0
  resetJudgmentEndpointAvailabilityForTests()
}

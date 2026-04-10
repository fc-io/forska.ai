import {getProviderConnection} from '../../providers/providerConnectionRepository.ts'
import {testProviderConnectionHealth} from '../../providers/providerHealthService.ts'
import {workerLoadBalancer} from '../../utils/workerLoadBalancer.ts'
import {
  classifyConnectionFailure,
  ConnectionError,
  createConnectionError,
  parseConnectionFailureMessage,
  recordConnectionFailure,
  recordConnectionSuccess,
} from './connectionHealth.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {
  claimJudgmentEndpointAvailability,
  getJudgmentEndpointAvailability,
  resetJudgmentEndpointAvailabilityForTests,
} from './judgmentEndpointAvailability.ts'

type RequestSlot = {baseURL: string; release: () => void; requiresProbe: boolean}

type RequestWaiter<T> = {resolve: (value: T) => void; reject: (error: unknown) => void}

type ProviderRequestScope = {
  providerConnectionId: string | null
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

let codexInFlight = 0
let fallbackInFlight = 0

const normalizeProvider = (value: string | null | undefined): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  return v.length > 0 ? v : 'unknown'
}

const getNonCodexCapacity = () => {
  return getJudgmentsCapacity(1)
}

const getProviderRequestKey = ({providerConnectionId}: ProviderRequestScope): string | null => {
  return providerConnectionId ? `provider:${providerConnectionId}` : null
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

  if (!providerKey || maxInflight == null) {
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

const probeJudgmentEndpointAvailability = async ({
  baseURL,
  provider,
  providerConnectionId,
}: {
  baseURL: string
  provider: string | null | undefined
  providerConnectionId: string | null
}): Promise<void> => {
  if (!providerConnectionId) {
    return undefined
  }

  const connection = await getProviderConnection(providerConnectionId)

  if (!connection) {
    const failure = classifyConnectionFailure({
      context: {
        effectiveBaseURL: baseURL,
        endpointPath: getProviderProbeEndpointPath(provider),
        providerKind: provider ?? null,
      },
      error: new Error(`Provider connection ${providerConnectionId} not found for endpoint probe`),
    })

    recordConnectionFailure({effectiveBaseURL: baseURL, failure, providerConnectionId})

    throw new ConnectionError(failure.message, failure.effectiveBaseURL, failure)
  }

  const result = await testProviderConnectionHealth(connection, {effectiveBaseURL: baseURL})

  if (result.ok) {
    recordConnectionSuccess({effectiveBaseURL: baseURL, providerConnectionId})
    return undefined
  }

  const failure = getProbeFailure({
    baseURL,
    message: result.lastError ?? 'Provider connection health probe failed',
    provider,
  })

  recordConnectionFailure({effectiveBaseURL: baseURL, failure, providerConnectionId})

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
    providerConnectionId: providerScope.providerConnectionId,
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
    providerConnectionId: providerScope.providerConnectionId,
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
  return providerScope.providerUsesFamilyDefault ? acquireCodexRelease() : acquireCodexProviderRelease(providerScope)
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

  const maxActiveRequests = getNonCodexCapacity().perWorkerMaxInflightRequests
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
    maxActiveRequests: getNonCodexCapacity().perWorkerMaxInflightRequests,
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

const tryAcquireFallbackSlot = ({
  baseURL,
  providerScope,
}: {
  baseURL: string
  providerScope: ProviderRequestScope
}): SlotAcquisitionAttempt => {
  const releaseProviderRequest = acquireProviderRequestRelease(providerScope)
  const maxInflight = getNonCodexCapacity().maxInflight
  const canAcquireFallback = fallbackInFlight < maxInflight

  if (!releaseProviderRequest || !canAcquireFallback) {
    return releaseProviderRequest ? (releaseProviderRequest(), {type: 'waiting'}) : {type: 'waiting'}
  }

  const requiresProbe = getEndpointAvailabilityState({baseURL, providerScope}).status !== 'healthy'

  if (!claimEndpointAvailability({baseURL, providerScope})) {
    releaseProviderRequest()
    return {type: 'blocked'}
  }

  fallbackInFlight += 1

  return {
    slot: {
      baseURL,
      release: () => {
        fallbackInFlight = Math.max(0, fallbackInFlight - 1)
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
  providerConnectionId,
  providerMaxInflightRequests,
  providerUsesFamilyDefault,
  workerUrls,
}: {
  provider: string | null | undefined
  fallbackBaseURL: string
  providerConnectionId: string | null
  providerMaxInflightRequests: number | null
  providerUsesFamilyDefault: boolean
  workerUrls: string[]
}): Promise<RequestSlot> => {
  const providerScope = {providerConnectionId, providerMaxInflightRequests, providerUsesFamilyDefault}

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
    providerConnectionId,
    providerMaxInflightRequests,
    providerUsesFamilyDefault,
    workerUrls,
  }: {
    judgmentsJobId: string
    provider: string | null | undefined
    fallbackBaseURL: string
    providerConnectionId: string | null
    providerMaxInflightRequests: number | null
    providerUsesFamilyDefault: boolean
    workerUrls: string[]
  },
  run: (baseURL: string) => Promise<T>,
): Promise<T> => {
  const slot = await acquireRequestSlot({
    fallbackBaseURL,
    provider,
    providerConnectionId,
    providerMaxInflightRequests,
    providerUsesFamilyDefault,
    workerUrls,
  })
  markRequestStarted(judgmentsJobId)

  try {
    if (slot.requiresProbe) {
      await probeJudgmentEndpointAvailability({baseURL: slot.baseURL, provider, providerConnectionId})
    }

    return await run(slot.baseURL)
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
  codexInFlight = 0
  fallbackInFlight = 0
  resetJudgmentEndpointAvailabilityForTests()
}

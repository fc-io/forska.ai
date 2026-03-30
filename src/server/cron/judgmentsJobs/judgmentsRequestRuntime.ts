import {workerLoadBalancer} from '../../utils/workerLoadBalancer.ts'
import {ConnectionError, isCircuitOpen} from './connectionHealth.ts'
import {getCodexMaxInflight} from './getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'

type RequestSlot = {baseURL: string; release: () => void}

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

const buildWorkerCircuitError = (workerUrls: string[]): ConnectionError => {
  const firstWorker = workerUrls[0]
  const baseURL = firstWorker ? `${firstWorker}/v1` : 'worker://unavailable'
  return new ConnectionError('All inference workers blocked by circuit breaker', baseURL)
}

const hasHealthyWorker = (workerUrls: string[]): boolean => {
  return workerUrls.some((url) => {
    return !isCircuitOpen(`${url}/v1`)
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

const buildWorkerSlot = (workerUrl: string, releaseProviderRequest: () => void): RequestSlot => {
  return {
    baseURL: `${workerUrl}/v1`,
    release: () => {
      workerLoadBalancer.releaseWorker(workerUrl)
      releaseProviderRequest()
      drainProviderScopedWaiters()
    },
  }
}

const tryAcquireWorkerSlot = ({
  providerScope,
  workerUrls,
}: {
  providerScope: ProviderRequestScope
  workerUrls: string[]
}): RequestSlot | null => {
  const releaseProviderRequest = acquireProviderRequestRelease(providerScope)
  if (!releaseProviderRequest) return null

  const workerUrl = workerLoadBalancer.acquireWorkerUrl({
    maxActiveRequests: getNonCodexCapacity().perWorkerMaxInflightRequests,
    workerUrls,
    canUse: (url) => {
      return !isCircuitOpen(`${url}/v1`)
    },
  })

  return workerUrl ? buildWorkerSlot(workerUrl, releaseProviderRequest) : (releaseProviderRequest(), null)
}

const drainWorkerWaiters = (): void => {
  const nextAction = workerWaiters.reduce<
    {error: ConnectionError; index: number; type: 'reject'} | {index: number; slot: RequestSlot; type: 'resolve'} | null
  >((state, waiter, index) => {
    if (state) return state

    if (!hasHealthyWorker(waiter.workerUrls)) {
      return {error: buildWorkerCircuitError(waiter.workerUrls), index, type: 'reject'}
    }

    const slot = tryAcquireWorkerSlot(waiter)
    return slot ? {index, slot, type: 'resolve'} : null
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
  const slot = tryAcquireWorkerSlot({providerScope, workerUrls})

  if (slot) return slot
  if (!hasHealthyWorker(workerUrls)) throw buildWorkerCircuitError(workerUrls)

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
}): RequestSlot | null => {
  const releaseProviderRequest = acquireProviderRequestRelease(providerScope)
  const maxInflight = getNonCodexCapacity().maxInflight
  const canAcquireFallback = fallbackInFlight < maxInflight

  if (!releaseProviderRequest || !canAcquireFallback) {
    return releaseProviderRequest ? (releaseProviderRequest(), null) : null
  }

  fallbackInFlight += 1

  return {
    baseURL,
    release: () => {
      fallbackInFlight = Math.max(0, fallbackInFlight - 1)
      releaseProviderRequest()
      drainProviderScopedWaiters()
    },
  }
}

const drainFallbackWaiters = (): void => {
  const nextAction = fallbackWaiters.reduce<
    {error: ConnectionError; index: number; type: 'reject'} | {index: number; slot: RequestSlot; type: 'resolve'} | null
  >((state, waiter, index) => {
    if (state) return state

    if (isCircuitOpen(waiter.baseURL)) {
      return {
        error: new ConnectionError('Inference server blocked by circuit breaker', waiter.baseURL),
        index,
        type: 'reject',
      }
    }

    const slot = tryAcquireFallbackSlot(waiter)
    return slot ? {index, slot, type: 'resolve'} : null
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
  if (isCircuitOpen(baseURL)) {
    throw new ConnectionError('Inference server blocked by circuit breaker', baseURL)
  }

  const slot = tryAcquireFallbackSlot({baseURL, providerScope})
  if (slot) return slot

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
        return {baseURL: fallbackBaseURL, release}
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
}

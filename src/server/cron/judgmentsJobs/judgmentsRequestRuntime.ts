import {workerLoadBalancer} from '../../utils/workerLoadBalancer.ts'
import {ConnectionError, isCircuitOpen} from './connectionHealth.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'

type RequestSlot = {baseURL: string; release: () => void}

type RequestWaiter<T> = {resolve: (value: T) => void; reject: (error: unknown) => void}

type FallbackWaiter = RequestWaiter<RequestSlot> & {baseURL: string}
type WorkerWaiter = RequestWaiter<RequestSlot> & {workerUrls: string[]}

type JobRequestState = {inFlight: number; pendingPersistedAttempts: number}

const DEFAULT_CODEX_MAX_INFLIGHT = 1

const codexWaiters: RequestWaiter<() => void>[] = []
const workerWaiters: WorkerWaiter[] = []
const fallbackWaiters: FallbackWaiter[] = []
const jobRequestStates = new Map<string, JobRequestState>()

let codexInFlight = 0
let fallbackInFlight = 0

const normalizeProvider = (value: string | null | undefined): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  return v.length > 0 ? v : 'unknown'
}

const getCodexMaxInflight = (): number => {
  const raw = Number(process.env.CODEX_MAX_INFLIGHT)
  const normalized = Number.isFinite(raw) ? Math.trunc(raw) : 0
  return normalized > 0 ? normalized : DEFAULT_CODEX_MAX_INFLIGHT
}

const getNonCodexCapacity = () => {
  return getJudgmentsCapacity(1)
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

const buildWorkerSlot = (workerUrl: string): RequestSlot => {
  return {
    baseURL: `${workerUrl}/v1`,
    release: () => {
      workerLoadBalancer.releaseWorker(workerUrl)
      drainWorkerWaiters()
    },
  }
}

const tryAcquireWorkerSlot = (workerUrls: string[]): RequestSlot | null => {
  const workerUrl = workerLoadBalancer.acquireWorkerUrl({
    maxActiveRequests: getNonCodexCapacity().perWorkerMaxInflightRequests,
    workerUrls,
    canUse: (url) => {
      return !isCircuitOpen(`${url}/v1`)
    },
  })

  return workerUrl ? buildWorkerSlot(workerUrl) : null
}

const drainWorkerWaiters = (): void => {
  const waiter = workerWaiters[0]
  const slot = waiter ? tryAcquireWorkerSlot(waiter.workerUrls) : null

  if (waiter && slot) {
    workerWaiters.shift()
    waiter.resolve(slot)
    drainWorkerWaiters()
  }

  if (waiter && !slot && !hasHealthyWorker(waiter.workerUrls)) {
    workerWaiters.shift()
    waiter.reject(buildWorkerCircuitError(waiter.workerUrls))
    drainWorkerWaiters()
  }
}

const acquireWorkerSlot = async (workerUrls: string[]): Promise<RequestSlot> => {
  const slot = tryAcquireWorkerSlot(workerUrls)

  if (slot) return slot
  if (!hasHealthyWorker(workerUrls)) throw buildWorkerCircuitError(workerUrls)

  return new Promise((resolve, reject) => {
    workerWaiters.push({reject, resolve, workerUrls})
  })
}

const drainFallbackWaiters = (): void => {
  const waiter = fallbackWaiters[0]
  const maxInflight = getNonCodexCapacity().maxInflight
  const canAcquire = Boolean(waiter) && fallbackInFlight < maxInflight

  return !waiter
    ? undefined
    : isCircuitOpen(waiter.baseURL)
      ? (() => {
          fallbackWaiters.shift()
          waiter.reject(new ConnectionError('Inference server blocked by circuit breaker', waiter.baseURL))
          drainFallbackWaiters()
        })()
      : canAcquire
        ? (() => {
            fallbackInFlight += 1
            fallbackWaiters.shift()
            waiter.resolve({
              baseURL: waiter.baseURL,
              release: () => {
                fallbackInFlight = Math.max(0, fallbackInFlight - 1)
                drainFallbackWaiters()
              },
            })
            drainFallbackWaiters()
          })()
        : undefined
}

const acquireFallbackSlot = async (baseURL: string): Promise<RequestSlot> => {
  if (isCircuitOpen(baseURL)) {
    throw new ConnectionError('Inference server blocked by circuit breaker', baseURL)
  }

  const maxInflight = getNonCodexCapacity().maxInflight
  const canAcquire = fallbackInFlight < maxInflight

  if (canAcquire) {
    fallbackInFlight += 1
    return {
      baseURL,
      release: () => {
        fallbackInFlight = Math.max(0, fallbackInFlight - 1)
        drainFallbackWaiters()
      },
    }
  }

  return new Promise((resolve, reject) => {
    fallbackWaiters.push({baseURL, resolve, reject})
  })
}

const acquireRequestSlot = async ({
  provider,
  fallbackBaseURL,
  workerUrls,
}: {
  provider: string | null | undefined
  fallbackBaseURL: string
  workerUrls: string[]
}): Promise<RequestSlot> => {
  return normalizeProvider(provider) === 'codex'
    ? acquireCodexRelease().then((release) => {
        return {baseURL: fallbackBaseURL, release}
      })
    : workerUrls.length > 0
      ? acquireWorkerSlot(workerUrls)
      : acquireFallbackSlot(fallbackBaseURL)
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
    workerUrls,
  }: {judgmentsJobId: string; provider: string | null | undefined; fallbackBaseURL: string; workerUrls: string[]},
  run: (baseURL: string) => Promise<T>,
): Promise<T> => {
  const slot = await acquireRequestSlot({fallbackBaseURL, provider, workerUrls})
  markRequestStarted(judgmentsJobId)

  try {
    return await run(slot.baseURL)
  } finally {
    markRequestFinished(judgmentsJobId)
    slot.release()
  }
}

import {env} from './env.ts'

const activeRequests = new Map<string, number>()

const getWorkerUrls = (): string[] => {
  return env.WORKER_URLS
}

const ensureWorkersInitialized = (): void => {
  return getWorkerUrls().forEach((url) => {
    if (!activeRequests.has(url)) {
      activeRequests.set(url, 0)
    }
  })
}

const getEligibleWorkers = ({
  maxActiveRequests,
  canUse,
}: {
  maxActiveRequests: number
  canUse?: (url: string) => boolean
}): string[] => {
  ensureWorkersInitialized()

  return getWorkerUrls().filter((url) => {
    const active = activeRequests.get(url) || 0
    const allowedByPredicate = canUse ? canUse(url) : true
    return allowedByPredicate && active < maxActiveRequests
  })
}

const getLeastBusyWorker = (workerUrls: string[]): string | null => {
  const selected = workerUrls.reduce<{url: string | null; active: number}>(
    (acc, url) => {
      const active = activeRequests.get(url) || 0
      return active < acc.active ? {url, active} : acc
    },
    {url: null, active: Number.POSITIVE_INFINITY},
  )

  return selected.url
}

export const workerLoadBalancer = {
  /**
   * Gets a worker URL with the fewest active requests.
   * Increments the active request count for the selected worker.
   */
  getWorkerUrl: (): string | null => {
    const workerUrls = getWorkerUrls()
    const selectedWorker = workerUrls.length === 0 ? null : getLeastBusyWorker(workerUrls)

    if (!selectedWorker) return null

    activeRequests.set(selectedWorker, (activeRequests.get(selectedWorker) || 0) + 1)

    return selectedWorker
  },

  acquireWorkerUrl: ({
    maxActiveRequests,
    canUse,
  }: {
    maxActiveRequests: number
    canUse?: (url: string) => boolean
  }): string | null => {
    const eligibleWorkers = getEligibleWorkers({maxActiveRequests, canUse})
    const selectedWorker = eligibleWorkers.length === 0 ? null : getLeastBusyWorker(eligibleWorkers)

    if (!selectedWorker) return null

    activeRequests.set(selectedWorker, (activeRequests.get(selectedWorker) || 0) + 1)

    return selectedWorker
  },

  /**
   * Decrements the active request count for a worker.
   * Handles URLs with or without the /v1 suffix.
   */
  releaseWorker: (urlWithVersion: string) => {
    if (!urlWithVersion) return

    let url = urlWithVersion
    // Strip /v1 suffix if present to match the keys stored from WORER_URLS
    if (url.endsWith('/v1')) {
      url = url.slice(0, -3)
    }

    // Strip trailing slash if present (just in case)
    if (url.endsWith('/')) {
      url = url.slice(0, -1)
    }

    const current = activeRequests.get(url)
    if (current !== undefined && current > 0) {
      activeRequests.set(url, current - 1)
    }
  },

  /**
   * Debug helper to see current distribution
   */
  getStats: () => {
    return Object.fromEntries(activeRequests)
  },
}

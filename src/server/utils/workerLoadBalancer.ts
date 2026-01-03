import {env} from './env.ts'

const activeRequests = new Map<string, number>()

export const workerLoadBalancer = {
  /**
   * Gets a worker URL with the fewest active requests.
   * Increments the active request count for the selected worker.
   */
  getWorkerUrl: (): string | null => {
    const workerUrls = env.WORKER_URLS
    if (workerUrls.length === 0) return null

    // Initialize missing keys
    workerUrls.forEach((url) => {
      if (!activeRequests.has(url)) {
        activeRequests.set(url, 0)
      }
    })

    // Find worker with min count
    let minCount = Infinity
    let selectedWorker = workerUrls[0]

    // Simple robust selection
    for (const url of workerUrls) {
      const count = activeRequests.get(url) || 0
      if (count < minCount) {
        minCount = count
        selectedWorker = url
      }
    }

    // Increment
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

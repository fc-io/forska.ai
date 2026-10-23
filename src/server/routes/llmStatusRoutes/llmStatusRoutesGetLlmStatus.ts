import {buildLlmStatusResponse} from './llmStatusRoutesGetLlmStatus/buildLlmStatusResponse.ts'
import type {LlmStatusResponseBody} from './llmStatusRoutesGetLlmStatus/llmStatusTypes.ts'
import {readLlmStatus} from './llmStatusRoutesGetLlmStatus/readLlmStatus.ts'

const llmStatusForegroundBudgetMs = 2500

let cachedLlmStatus: LlmStatusResponseBody | null = null
let pendingLlmStatusRefresh: Promise<LlmStatusResponseBody> | null = null

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timeout: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      resolve(null)
    }, timeoutMs)
  })

  const result = await Promise.race([promise, timeoutPromise])

  if (timeout !== null) {
    clearTimeout(timeout)
  }

  return result
}

const refreshLlmStatusMetadata = (status: LlmStatusResponseBody) => {
  return buildLlmStatusResponse({
    data: status.data,
    hasMetricsCompatibleJob: status.hasMetricsCompatibleJob,
    hasMetricsCompatibleRuntime: status.hasMetricsCompatibleRuntime,
    tableExists: status.metadata.tableExists,
  })
}

const refreshLlmStatus = async () => {
  pendingLlmStatusRefresh ??= readLlmStatus()
    .then((status) => {
      cachedLlmStatus = status
      return status
    })
    .finally(() => {
      pendingLlmStatusRefresh = null
    })

  return pendingLlmStatusRefresh
}

const isFreshReadRequested = (value: string | undefined) => {
  return value === '1' || value === 'true'
}

export const __resetLlmStatusCacheForTests = () => {
  cachedLlmStatus = null
  pendingLlmStatusRefresh = null
}

export const llmStatusRoutesGetLlmStatus = async ({query}: {query: {fresh?: string}}) => {
  const shouldReadFresh = isFreshReadRequested(query.fresh)

  if (cachedLlmStatus !== null && !shouldReadFresh) {
    void refreshLlmStatus().catch(() => {})
    return refreshLlmStatusMetadata(cachedLlmStatus)
  }

  const status = await withTimeout(refreshLlmStatus(), llmStatusForegroundBudgetMs)

  if (status !== null) {
    return status
  }

  return cachedLlmStatus !== null
    ? refreshLlmStatusMetadata(cachedLlmStatus)
    : buildLlmStatusResponse({
        data: [],
        hasMetricsCompatibleJob: false,
        hasMetricsCompatibleRuntime: false,
        tableExists: null,
      })
}

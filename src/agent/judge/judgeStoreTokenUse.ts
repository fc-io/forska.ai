import {markJudgmentRequestsPersisted} from '../../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts'
import {getTokenUseQueryService} from '../../server/services/tokenUseQueryService.ts'
import {parseDuckdbMemoryLimitToMiB} from '../../server/utils/duckdbMemoryLimit.ts'
import {inferenceRuntimeConfig} from '../../server/utils/getInferenceRuntimeConfig.ts'
import {apiClient} from '../../services/apiClient.ts'

export type JudgeTokenUsageEntry = {
  articleId: string
  promptIds: string[]
  modelId: string
  modelName: string
  baseURL: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  outcome: 'success' | 'failure'
  error: string | null
  sanitizationAttempted: boolean
  sanitizedError: string | null
  sanitizedResponse: string | null
  lastResponse: string | null
  systemPrompt: string | null
  userPrompt: string | null
  failureCode?: string | null
  pendingQueueRetry?: boolean
  providerDiagnostics?: unknown
}

type FailedRequestDetail = {
  articleId: string
  promptIds: string[]
  modelId: string
  modelName: string
  baseURL: string
  failureType: 'retry' | 'total_failure'
  attempts: number
  failedAttempts: number
  failedPromptTokens: number
  failedCompletionTokens: number
  failedTotalTokens: number
  error: string | null
  sanitizationAttempted: boolean
  sanitizedError: string | null
  sanitizedResponse: string | null
  lastResponse: string | null
  systemPrompt: string | null
  userPrompt: string | null
  failureCode?: string | null
  providerDiagnostics?: unknown
}

type FailedRequestAggregation = {
  articleId: string
  promptIds: string[]
  modelId: string
  modelName: string
  baseURL: string
  attempts: number
  failedAttempts: number
  hasSuccess: boolean
  failedPromptTokens: number
  failedCompletionTokens: number
  failedTotalTokens: number
  lastError: string | null
  sanitizationAttempted: boolean
  sanitizedError: string | null
  sanitizedResponse: string | null
  lastResponse: string | null
  systemPrompt: string | null
  userPrompt: string | null
  failureCode: string | null
  pendingQueueRetry: boolean
  providerDiagnostics: unknown
}

/**
 * Check if an error message indicates a connection error.
 * Connection errors are network-level failures that should not be stored
 * as they are transient and not actionable for debugging LLM responses.
 */
const isConnectionError = (error: string | null): boolean => {
  if (!error) return false
  const lowerError = error.toLowerCase()
  return lowerError.includes('connection error')
}

type TokenUseTotals = {
  modelName: string | null
  totalRequests: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalSuccessPromptTokens: number
  totalSuccessCompletionTokens: number
  totalSuccessTokens: number
  totalFailedPromptTokens: number
  totalFailedCompletionTokens: number
  totalFailedTokens: number
  successfulRequests: number
  failedRequests: number
  hasFailedRequests: boolean
  failedRequestsDetails: FailedRequestDetail[]
}

const isServerEnvironment = (): boolean => {
  return typeof window === 'undefined' || typeof Bun !== 'undefined'
}

const shouldSkipTokenUsePersistence = () => {
  const serverRole = String(process.env.SERVER_ROLE ?? '').trim()
  const workerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT)

  return (
    (serverRole === 'judge-worker'
      || serverRole === 'maintenance-worker'
      || serverRole === 'worker'
      || serverRole === 'writer')
    && workerDuckdbMemoryLimitMiB !== null
    && workerDuckdbMemoryLimitMiB <= 6400
  )
}

const getStoredModelName = (tokenUseEntries: JudgeTokenUsageEntry[]): string | null => {
  return tokenUseEntries.reduce<string | null>((resolved, entry) => {
    const normalized = String(entry.modelName ?? '').trim()

    return resolved ?? (normalized === '' ? null : normalized)
  }, null)
}

const storeTokenUseDirectly = async (
  totalTokenUse: TokenUseTotals,
  _sessionId: string | null,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
  judgmentsJobId?: string,
): Promise<void> => {
  const result = await getTokenUseQueryService().insertTokenUse({
    judgment_job_id: judgmentsJobId ?? null,
    gpu_nnodes: inferenceRuntimeConfig.gpuNnodes,
    gpu_gpus_per_node: inferenceRuntimeConfig.gpuGpusPerNode,
    gpu_total_gpus: inferenceRuntimeConfig.gpuTotalGpus,
    tp_size: inferenceRuntimeConfig.tpSize,
    dp_size: inferenceRuntimeConfig.dpSize,
    gpu_shape: inferenceRuntimeConfig.gpuShape,
    sglang_max_running_requests: inferenceRuntimeConfig.sglangMaxRunningRequests,
    sglang_model: totalTokenUse.modelName,
    requests: totalTokenUse.totalRequests,
    total_prompt_tokens: totalTokenUse.totalPromptTokens,
    total_completion_tokens: totalTokenUse.totalCompletionTokens,
    total_tokens: totalTokenUse.totalTokens,
    successful_requests: totalTokenUse.successfulRequests,
    failed_requests: totalTokenUse.failedRequests,
    has_failed_requests: totalTokenUse.hasFailedRequests,
    failed_requests_details:
      totalTokenUse.failedRequestsDetails.length > 0 ? totalTokenUse.failedRequestsDetails : null,
    total_success_prompt_tokens: totalTokenUse.totalSuccessPromptTokens,
    total_success_completion_tokens: totalTokenUse.totalSuccessCompletionTokens,
    total_success_tokens: totalTokenUse.totalSuccessTokens,
    total_failed_prompt_tokens: totalTokenUse.totalFailedPromptTokens,
    total_failed_completion_tokens: totalTokenUse.totalFailedCompletionTokens,
    total_failed_tokens: totalTokenUse.totalFailedTokens,
    started_at: new Date(startedAt),
    finished_at: new Date(finishedAt),
    duration: Math.round(duration),
  })

  if (!result) {
    throw new Error('Failed to store token usage in database')
  }
}

const storeTokenUseViaAPI = async (
  totalTokenUse: TokenUseTotals,
  judgmentsJobId: string,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
): Promise<void> => {
  const response = await apiClient.api.tokens.usage.post({
    judgmentsJobId,
    sglangModel: totalTokenUse.modelName ?? undefined,
    requests: totalTokenUse.totalRequests,
    totalPromptTokens: totalTokenUse.totalPromptTokens,
    totalCompletionTokens: totalTokenUse.totalCompletionTokens,
    totalTokens: totalTokenUse.totalTokens,
    successfulRequests: totalTokenUse.successfulRequests,
    failedRequests: totalTokenUse.failedRequests,
    hasFailedRequests: totalTokenUse.hasFailedRequests,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    failedRequestsDetails: totalTokenUse.failedRequestsDetails as any,
    totalSuccessPromptTokens: totalTokenUse.totalSuccessPromptTokens,
    totalSuccessCompletionTokens: totalTokenUse.totalSuccessCompletionTokens,
    totalSuccessTokens: totalTokenUse.totalSuccessTokens,
    totalFailedPromptTokens: totalTokenUse.totalFailedPromptTokens,
    totalFailedCompletionTokens: totalTokenUse.totalFailedCompletionTokens,
    totalFailedTokens: totalTokenUse.totalFailedTokens,
    startedAt,
    finishedAt,
    duration: Math.round(duration),
  })

  if (response.error || response.data?.error) {
    const errorMessage = 'Failed to store token use: API request failed'
    console.error(new Error(errorMessage))
    throw new Error(errorMessage)
  }

  const data = response.data as {success: boolean; error?: string} | undefined

  if (!data?.success) {
    const errorMessage = data?.error || 'Failed to store token use'
    console.error(new Error(errorMessage))
    throw new Error(errorMessage)
  }
}

export const buildTokenUseTotals = (tokenUseEntries: JudgeTokenUsageEntry[]): TokenUseTotals => {
  const totals = tokenUseEntries.reduce(
    (acc, entry) => {
      const totalPromptTokens = acc.totalPromptTokens + entry.promptTokens
      const totalCompletionTokens = acc.totalCompletionTokens + entry.completionTokens
      const totalTokens = acc.totalTokens + entry.totalTokens
      const isFailure = entry.outcome === 'failure'
      const totalSuccessPromptTokens = acc.totalSuccessPromptTokens + (isFailure ? 0 : entry.promptTokens)
      const totalSuccessCompletionTokens = acc.totalSuccessCompletionTokens + (isFailure ? 0 : entry.completionTokens)
      const totalSuccessTokens = acc.totalSuccessTokens + (isFailure ? 0 : entry.totalTokens)
      const totalFailedPromptTokens = acc.totalFailedPromptTokens + (isFailure ? entry.promptTokens : 0)
      const totalFailedCompletionTokens = acc.totalFailedCompletionTokens + (isFailure ? entry.completionTokens : 0)
      const totalFailedTokens = acc.totalFailedTokens + (isFailure ? entry.totalTokens : 0)

      return {
        totalRequests: acc.totalRequests,
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        totalSuccessPromptTokens,
        totalSuccessCompletionTokens,
        totalSuccessTokens,
        totalFailedPromptTokens,
        totalFailedCompletionTokens,
        totalFailedTokens,
        successfulRequests: acc.successfulRequests,
        failedRequests: acc.failedRequests,
        hasFailedRequests: acc.hasFailedRequests,
        failedRequestsDetails: acc.failedRequestsDetails,
      }
    },
    {
      totalRequests: tokenUseEntries.length,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalSuccessPromptTokens: 0,
      totalSuccessCompletionTokens: 0,
      totalSuccessTokens: 0,
      totalFailedPromptTokens: 0,
      totalFailedCompletionTokens: 0,
      totalFailedTokens: 0,
      successfulRequests: 0,
      failedRequests: 0,
      hasFailedRequests: false,
      failedRequestsDetails: [] as FailedRequestDetail[],
    },
  )

  const groupedByRequest = tokenUseEntries.reduce((map, entry) => {
    const key = `${entry.articleId}|${entry.modelId}|${entry.baseURL}`
    const existing =
      map.get(key)
      ?? ({
        articleId: entry.articleId,
        promptIds: entry.promptIds,
        modelId: entry.modelId,
        modelName: entry.modelName,
        baseURL: entry.baseURL,
        attempts: 0,
        failedAttempts: 0,
        hasSuccess: false,
        failedPromptTokens: 0,
        failedCompletionTokens: 0,
        failedTotalTokens: 0,
        lastError: null,
        sanitizationAttempted: false,
        sanitizedError: null,
        sanitizedResponse: null,
        lastResponse: null,
        systemPrompt: null,
        userPrompt: null,
        failureCode: null,
        pendingQueueRetry: false,
        providerDiagnostics: null,
      } satisfies FailedRequestAggregation)

    const attempts = existing.attempts + 1
    const isFailure = entry.outcome === 'failure'
    const isConnectionFailure = isFailure && isConnectionError(entry.error)
    const failedAttempts = existing.failedAttempts + (isFailure ? 1 : 0)
    const hasSuccess = existing.hasSuccess || entry.outcome === 'success'
    const failedPromptTokens = existing.failedPromptTokens + (isFailure ? entry.promptTokens : 0)
    const failedCompletionTokens = existing.failedCompletionTokens + (isFailure ? entry.completionTokens : 0)
    const failedTotalTokens = existing.failedTotalTokens + (isFailure ? entry.totalTokens : 0)
    const lastError = isFailure && !isConnectionFailure ? (entry.error ?? existing.lastError) : existing.lastError
    const lastResponse =
      isFailure && !isConnectionFailure ? (entry.lastResponse ?? existing.lastResponse) : existing.lastResponse
    const systemPrompt =
      isFailure && !isConnectionFailure ? (entry.systemPrompt ?? existing.systemPrompt) : existing.systemPrompt
    const userPrompt =
      isFailure && !isConnectionFailure ? (entry.userPrompt ?? existing.userPrompt) : existing.userPrompt
    const failureCode =
      isFailure && !isConnectionFailure ? (entry.failureCode ?? existing.failureCode) : existing.failureCode
    const pendingQueueRetry = existing.pendingQueueRetry || (isFailure && entry.pendingQueueRetry === true)
    const providerDiagnostics =
      isFailure && !isConnectionFailure
        ? (entry.providerDiagnostics ?? existing.providerDiagnostics)
        : existing.providerDiagnostics

    const sanitizationAttempted =
      isFailure && !isConnectionFailure ? entry.sanitizationAttempted : existing.sanitizationAttempted
    const sanitizedError =
      isFailure && !isConnectionFailure ? (entry.sanitizedError ?? existing.sanitizedError) : existing.sanitizedError
    const sanitizedResponse =
      isFailure && !isConnectionFailure
        ? (entry.sanitizedResponse ?? existing.sanitizedResponse)
        : existing.sanitizedResponse

    map.set(key, {
      articleId: existing.articleId,
      promptIds: existing.promptIds,
      modelId: existing.modelId,
      modelName: existing.modelName,
      baseURL: existing.baseURL,
      attempts,
      failedAttempts,
      hasSuccess,
      failedPromptTokens,
      failedCompletionTokens,
      failedTotalTokens,
      lastError,
      sanitizationAttempted,
      sanitizedError,
      sanitizedResponse,
      lastResponse,
      systemPrompt,
      userPrompt,
      failureCode,
      pendingQueueRetry,
      providerDiagnostics,
    })

    return map
  }, new Map<string, FailedRequestAggregation>())

  const failedRequestsDetails: FailedRequestDetail[] = Array.from(groupedByRequest.values())
    .filter((request) => {
      return request.failedAttempts > 0 && request.lastError !== null
    })
    .map((request) => {
      const failureType: FailedRequestDetail['failureType'] =
        request.hasSuccess || request.pendingQueueRetry ? 'retry' : 'total_failure'

      return {
        articleId: request.articleId,
        promptIds: request.promptIds,
        modelId: request.modelId,
        modelName: request.modelName,
        baseURL: request.baseURL,
        failureType,
        attempts: request.attempts,
        failedAttempts: request.failedAttempts,
        failedPromptTokens: request.failedPromptTokens,
        failedCompletionTokens: request.failedCompletionTokens,
        failedTotalTokens: request.failedTotalTokens,
        error: request.lastError,
        sanitizationAttempted: request.sanitizationAttempted,
        sanitizedError: request.sanitizedError,
        sanitizedResponse: request.sanitizedResponse,
        lastResponse: request.lastResponse,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        failureCode: request.failureCode,
        providerDiagnostics: request.providerDiagnostics,
      }
    })

  const failedRequests = tokenUseEntries.filter((entry) => {
    return entry.outcome === 'failure' && !isConnectionError(entry.error)
  }).length

  const successfulRequests = tokenUseEntries.filter((entry) => {
    return entry.outcome === 'success'
  }).length
  const hasFailedRequests = failedRequestsDetails.length > 0

  return {
    modelName: getStoredModelName(tokenUseEntries),
    totalRequests: totals.totalRequests,
    totalPromptTokens: totals.totalPromptTokens,
    totalCompletionTokens: totals.totalCompletionTokens,
    totalTokens: totals.totalTokens,
    totalSuccessPromptTokens: totals.totalSuccessPromptTokens,
    totalSuccessCompletionTokens: totals.totalSuccessCompletionTokens,
    totalSuccessTokens: totals.totalSuccessTokens,
    totalFailedPromptTokens: totals.totalFailedPromptTokens,
    totalFailedCompletionTokens: totals.totalFailedCompletionTokens,
    totalFailedTokens: totals.totalFailedTokens,
    successfulRequests,
    failedRequests,
    hasFailedRequests,
    failedRequestsDetails,
  }
}

export const judgeStoreTokenUse = async (
  tokenUseEntries: JudgeTokenUsageEntry[],
  _sessionId: string | null,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
  judgmentsJobId: string,
): Promise<void> => {
  const totalTokenUse = buildTokenUseTotals(tokenUseEntries)

  if (isServerEnvironment() && !shouldSkipTokenUsePersistence()) {
    await storeTokenUseDirectly(totalTokenUse, null, {startedAt, finishedAt, duration}, judgmentsJobId)
  } else if (!isServerEnvironment()) {
    await storeTokenUseViaAPI(totalTokenUse, judgmentsJobId, {startedAt, finishedAt, duration})
  }

  markJudgmentRequestsPersisted(judgmentsJobId, totalTokenUse.totalRequests)
}

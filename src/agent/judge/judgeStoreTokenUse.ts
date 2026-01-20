import {eq} from 'drizzle-orm'

import {session} from '../../../auth-schema.ts'
import {tokenUse} from '../../db/schema.ts'
import {env} from '../../server/utils/env.ts'
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

/**
 * Context for storing token usage.
 * totalRequests is the number of prompts being processed (one LLM request per prompt).
 */
type JudgeTokenUseContext = {totalRequests: number}

const isServerEnvironment = (): boolean => {
  return typeof window === 'undefined' || typeof Bun !== 'undefined'
}

const storeTokenUseDirectly = async (
  totalRequests: number,
  totalTokenUse: TokenUseTotals,
  sessionId: string | null,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
  judgmentsJobId?: string,
): Promise<void> => {
  const {getDatabase} = await import('../../server/utils/getDatabase.ts')
  const db = getDatabase()

  const [sessionData] = sessionId
    ? await db.select({userId: session.userId}).from(session).where(eq(session.id, sessionId)).limit(1)
    : [null]

  const [result] = await db
    .insert(tokenUse)
    .values({
      userId: sessionData?.userId ?? null,
      sessionId,
      judgmentsJobId: judgmentsJobId ?? null,
      gpuNnodes: env.GPU_NNODES,
      gpuGpusPerNode: env.GPU_GPUS_PER_NODE,
      gpuTotalGpus: env.GPU_TOTAL_GPUS,
      tpSize: env.TP_SIZE,
      dpSize: env.DP_SIZE,
      gpuShape: env.GPU_SHAPE ?? null,
      sglangMaxRunningRequests: env.SGLANG_MAX_RUNNING_REQUESTS,
      sglangModel: env.SGLANG_MODEL ?? null,
      requests: totalRequests,
      totalPromptTokens: totalTokenUse.totalPromptTokens,
      totalCompletionTokens: totalTokenUse.totalCompletionTokens,
      totalTokens: totalTokenUse.totalTokens,
      successfulRequests: totalTokenUse.successfulRequests,
      failedRequests: totalTokenUse.failedRequests,
      hasFailedRequests: totalTokenUse.hasFailedRequests,
      failedRequestsDetails:
        totalTokenUse.failedRequestsDetails.length > 0 ? totalTokenUse.failedRequestsDetails : null,
      totalSuccessPromptTokens: totalTokenUse.totalSuccessPromptTokens,
      totalSuccessCompletionTokens: totalTokenUse.totalSuccessCompletionTokens,
      totalSuccessTokens: totalTokenUse.totalSuccessTokens,
      totalFailedPromptTokens: totalTokenUse.totalFailedPromptTokens,
      totalFailedCompletionTokens: totalTokenUse.totalFailedCompletionTokens,
      totalFailedTokens: totalTokenUse.totalFailedTokens,
      startedAt: new Date(startedAt),
      finishedAt: new Date(finishedAt),
      duration: Math.round(duration),
    })
    .returning()

  if (!result) {
    throw new Error('Failed to store token usage in database')
  }
}

const storeTokenUseViaAPI = async (
  totalRequests: number,
  totalTokenUse: TokenUseTotals,
  sessionId: string,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
): Promise<void> => {
  const response = await apiClient.api.tokens.usage.post({
    sessionId,
    requests: totalRequests,
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

const buildTokenUseTotals = (
  tokenUseEntries: JudgeTokenUsageEntry[],
  context: JudgeTokenUseContext,
): TokenUseTotals => {
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
      } satisfies FailedRequestAggregation)

    const attempts = existing.attempts + 1
    const failedAttempts = existing.failedAttempts + (entry.outcome === 'failure' ? 1 : 0)
    const hasSuccess = existing.hasSuccess || entry.outcome === 'success'
    const failedPromptTokens = existing.failedPromptTokens + (entry.outcome === 'failure' ? entry.promptTokens : 0)
    const failedCompletionTokens =
      existing.failedCompletionTokens + (entry.outcome === 'failure' ? entry.completionTokens : 0)
    const failedTotalTokens = existing.failedTotalTokens + (entry.outcome === 'failure' ? entry.totalTokens : 0)
    const lastError = entry.outcome === 'failure' ? (entry.error ?? existing.lastError) : existing.lastError
    const lastResponse =
      entry.outcome === 'failure' ? (entry.lastResponse ?? existing.lastResponse) : existing.lastResponse
    const systemPrompt =
      entry.outcome === 'failure' ? (entry.systemPrompt ?? existing.systemPrompt) : existing.systemPrompt
    const userPrompt = entry.outcome === 'failure' ? (entry.userPrompt ?? existing.userPrompt) : existing.userPrompt

    const sanitizationAttempted =
      entry.outcome === 'failure' ? entry.sanitizationAttempted : existing.sanitizationAttempted
    const sanitizedError =
      entry.outcome === 'failure' ? (entry.sanitizedError ?? existing.sanitizedError) : existing.sanitizedError
    const sanitizedResponse =
      entry.outcome === 'failure' ? (entry.sanitizedResponse ?? existing.sanitizedResponse) : existing.sanitizedResponse

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
    })

    return map
  }, new Map<string, FailedRequestAggregation>())

  const failedRequestsDetails: FailedRequestDetail[] = Array.from(groupedByRequest.values())
    .filter((request) => {
      // Exclude connection errors - these are transient network failures
      if (isConnectionError(request.lastError)) return false
      return request.failedAttempts > 0
    })
    .map((request) => {
      const failureType: FailedRequestDetail['failureType'] = request.hasSuccess ? 'retry' : 'total_failure'

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
      }
    })

  const failedRequests = failedRequestsDetails.filter((request) => {
    return request.failureType === 'total_failure'
  }).length

  const successfulRequests = context.totalRequests - failedRequests
  const hasFailedRequests = failedRequestsDetails.length > 0

  return {
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
  sessionId: string | null,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
  judgmentsJobId: string,
  context: JudgeTokenUseContext,
): Promise<void> => {
  const totalTokenUse = buildTokenUseTotals(tokenUseEntries, context)

  if (isServerEnvironment()) {
    await storeTokenUseDirectly(
      context.totalRequests,
      totalTokenUse,
      null,
      {startedAt, finishedAt, duration},
      judgmentsJobId,
    )
  } else {
    if (!sessionId) {
      throw new Error('sessionId is required when running in client environment')
    }
    await storeTokenUseViaAPI(context.totalRequests, totalTokenUse, sessionId, {startedAt, finishedAt, duration})
  }
}

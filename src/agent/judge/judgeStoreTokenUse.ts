import {eq} from 'drizzle-orm'

import {session} from '../../../auth-schema.ts'
import {tokenUse} from '../../db/schema.ts'
import {env} from '../../server/utils/env.ts'
import {apiClient} from '../../services/apiClient.ts'

const isServerEnvironment = (): boolean => {
  return typeof window === 'undefined' || typeof Bun !== 'undefined'
}

const storeTokenUseDirectly = async (
  totalArticles: number,
  totalTokenUse: {totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number},
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
      requests: totalArticles,
      totalPromptTokens: totalTokenUse.totalPromptTokens,
      totalCompletionTokens: totalTokenUse.totalCompletionTokens,
      totalTokens: totalTokenUse.totalTokens,
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
  totalArticles: number,
  totalTokenUse: {totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number},
  sessionId: string,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
): Promise<void> => {
  const response = await apiClient.api.tokens.usage.post({
    sessionId,
    requests: totalArticles,
    totalPromptTokens: totalTokenUse.totalPromptTokens,
    totalCompletionTokens: totalTokenUse.totalCompletionTokens,
    totalTokens: totalTokenUse.totalTokens,
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

export const judgeStoreTokenUse = async (
  tokenUse: {promptTokens: number; completionTokens: number; totalTokens: number}[],
  sessionId: string | null,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
  judgmentsJobId?: string,
): Promise<void> => {
  const totalArticles = tokenUse.length
  const totalTokenUse = tokenUse.reduce(
    (acc, {promptTokens, completionTokens, totalTokens}) => {
      return {
        totalPromptTokens: acc.totalPromptTokens + promptTokens,
        totalCompletionTokens: acc.totalCompletionTokens + completionTokens,
        totalTokens: acc.totalTokens + totalTokens,
      }
    },
    {totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0},
  )

  if (isServerEnvironment()) {
    await storeTokenUseDirectly(totalArticles, totalTokenUse, null, {startedAt, finishedAt, duration}, judgmentsJobId)
  } else {
    if (!sessionId) {
      throw new Error('sessionId is required when running in client environment')
    }
    await storeTokenUseViaAPI(totalArticles, totalTokenUse, sessionId, {startedAt, finishedAt, duration})
  }
}

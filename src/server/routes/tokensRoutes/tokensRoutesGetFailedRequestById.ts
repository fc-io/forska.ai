import {eq} from 'drizzle-orm'

import {judgmentsJobs, models, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type FailedRequestDetailItem = {modelId?: string; [key: string]: unknown}

type ModelInfo = {provider: string | null; modelName: string | null; version: string | null}

const getFirstModelId = (details: unknown): string | null => {
  const array = Array.isArray(details) ? (details as FailedRequestDetailItem[]) : []
  const found = array.find((d) => {
    return typeof d.modelId === 'string' && d.modelId.trim().length > 0
  })
  const modelId = typeof found?.modelId === 'string' ? found.modelId.trim() : ''
  return modelId.length > 0 ? modelId : null
}

export const tokensRoutesGetFailedRequestById = async (id: string) => {
  const db = getDatabase()

  const [result] = await db
    .select({
      id: tokenUse.id,
      createdAt: tokenUse.createdAt,
      judgmentsJobId: tokenUse.judgmentsJobId,
      projectId: judgmentsJobs.projectId,
      modelName: tokenUse.sglangModel,
      failedRequests: tokenUse.failedRequests,
      failedRequestsDetails: tokenUse.failedRequestsDetails,
      totalTokens: tokenUse.totalTokens,
      requests: tokenUse.requests,
      successfulRequests: tokenUse.successfulRequests,
    })
    .from(tokenUse)
    .leftJoin(judgmentsJobs, eq(tokenUse.judgmentsJobId, judgmentsJobs.id))
    .where(eq(tokenUse.id, id))

  if (!result) {
    return {success: false, error: 'Failed request not found'}
  }

  const modelId = getFirstModelId(result.failedRequestsDetails)
  const [modelRow] = modelId
    ? await db
        .select({provider: models.provider, modelName: models.modelName, version: models.version})
        .from(models)
        .where(eq(models.id, modelId))
        .limit(1)
    : [null]

  const modelInfo: ModelInfo | null = modelRow
    ? {provider: modelRow.provider ?? null, modelName: modelRow.modelName ?? null, version: modelRow.version ?? null}
    : null

  const modelName = modelInfo?.modelName ?? result.modelName ?? null
  const modelProvider = modelInfo?.provider ?? null
  const modelVersion = modelInfo?.version ?? null

  return {success: true, data: {...result, modelName, modelProvider, modelVersion}}
}

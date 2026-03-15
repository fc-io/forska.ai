import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'

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
  const tokenUseQueryService = getTokenUseQueryService()
  const result = await tokenUseQueryService.getFailedRequestById(id)

  if (!result) {
    return {success: false, error: 'Failed request not found'}
  }

  const modelId = getFirstModelId(result.failedRequestsDetails)
  const modelRow = modelId ? ((await tokenUseQueryService.getModelInfoMap([modelId])).get(modelId) ?? null) : null

  const modelInfo: ModelInfo | null = modelRow
    ? {provider: modelRow.provider ?? null, modelName: modelRow.modelName ?? null, version: modelRow.version ?? null}
    : null

  const modelName = modelInfo?.modelName ?? result.modelName ?? null
  const modelProvider = modelInfo?.provider ?? null
  const modelVersion = modelInfo?.version ?? null

  return {success: true, data: {...result, modelName, modelProvider, modelVersion}}
}

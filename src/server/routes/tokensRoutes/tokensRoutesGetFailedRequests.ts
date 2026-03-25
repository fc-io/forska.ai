import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'

type FailedRequestDetailItem = {promptIds?: string[]; modelId?: string; [key: string]: unknown}

type ModelInfo = {provider: string | null; modelName: string | null; version: string | null}

const getFirstModelId = (details: FailedRequestDetailItem[] | null): string | null => {
  const array = Array.isArray(details) ? details : []
  const found = array.find((d) => {
    return typeof d.modelId === 'string' && d.modelId.trim().length > 0
  })
  const modelId = typeof found?.modelId === 'string' ? found.modelId.trim() : ''
  return modelId.length > 0 ? modelId : null
}

type GetFailedRequestsParams = {limit?: number; offset?: number}

export const tokensRoutesGetFailedRequests = async ({limit = 50, offset = 0}: GetFailedRequestsParams) => {
  const tokenUseQueryService = getTokenUseQueryService()
  const result = await tokenUseQueryService.getFailedRequestsRows({limit, offset})

  // Collect all unique promptIds from failedRequestsDetails across all rows
  const allPromptIds = new Set<string>()
  const allModelIds = new Set<string>()
  for (const row of result) {
    const details = row.failedRequestsDetails as FailedRequestDetailItem[] | null
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (typeof detail.modelId === 'string' && detail.modelId.trim().length > 0) {
          allModelIds.add(detail.modelId.trim())
        }
        if (Array.isArray(detail.promptIds)) {
          for (const pid of detail.promptIds) {
            allPromptIds.add(pid)
          }
        }
      }
    }
  }

  // Fetch prompt headings for all collected promptIds
  let promptHeadingMap = new Map<string, string | null>()
  if (allPromptIds.size > 0) {
    promptHeadingMap = await tokenUseQueryService.getPromptHeadingMap(Array.from(allPromptIds))
  }

  let modelInfoMap = new Map<string, ModelInfo>()
  if (allModelIds.size > 0) {
    modelInfoMap = await tokenUseQueryService.getModelInfoMap(Array.from(allModelIds))
  }

  // Build prompt headings string for each row (using first promptIds from first detail)
  const dataWithHeadings = result.map((row) => {
    const details = row.failedRequestsDetails as FailedRequestDetailItem[] | null
    let promptHeadings: string | null = null

    const modelId = getFirstModelId(details)
    const model = modelId ? modelInfoMap.get(modelId) : null
    const modelName = model?.modelName ?? row.modelName ?? null
    const modelProvider = model?.provider ?? null
    const modelVersion = model?.version ?? null

    if (Array.isArray(details) && details.length > 0) {
      const firstDetail = details[0]
      if (Array.isArray(firstDetail?.promptIds) && firstDetail.promptIds.length > 0) {
        const headings = firstDetail.promptIds
          .map((pid) => {
            return promptHeadingMap.get(pid) ?? null
          })
          .filter((h): h is string => {
            return h !== null
          })
        promptHeadings = headings.length > 0 ? headings.join(', ') : null
      }
    }

    return {...row, promptHeadings, modelName, modelProvider, modelVersion}
  })

  // Get total count for pagination
  return {success: true, data: dataWithHeadings, total: await tokenUseQueryService.getFailedRequestsCount()}
}

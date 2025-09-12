import {apiClient} from '../../services/apiClient.ts'

export const judgeStoreTokenUse = async (
  tokenUse: {promptTokens: number; completionTokens: number; totalTokens: number}[],
  sessionId: string,
  {startedAt, finishedAt, duration}: {startedAt: string; finishedAt: string; duration: number},
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
  debugger
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

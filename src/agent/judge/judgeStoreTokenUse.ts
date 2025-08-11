import {getSupabaseClient} from '../../utils/getSupabaseClient.ts'

export const judgeStoreTokenUse = async (
  tokenUse: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }[],
  sessionId: string,
  {
    startedAt,
    finishedAt,
    duration,
  }: {startedAt: string; finishedAt: string; duration: number},
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

  const supabase = getSupabaseClient()
  const {error} = await supabase
    .from('2025_july_token_use')
    .insert({
      session_id: sessionId,
      requests: totalArticles,
      total_prompt_tokens: totalTokenUse.totalPromptTokens,
      total_completion_tokens: totalTokenUse.totalCompletionTokens,
      total_tokens: totalTokenUse.totalTokens,
      started_at: startedAt,
      finished_at: finishedAt,
      duration: Math.round(duration),
    })

  if (error) {
    console.error(new Error(`Failed to store token use: ${error.message}`))
    throw new Error(`Failed to store token use: ${error.message}`)
  }
}

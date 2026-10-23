import {getAppDatabaseService} from '../../services/appDatabaseService.ts'

export const judgmentsJobsRoutesGetTotalTokenUsage = async () => {
  const [totalUsage] = await getAppDatabaseService().queryJson<{
    totalTokens: number | null
    totalPromptTokens: number | null
    totalCompletionTokens: number | null
  }>(`
      SELECT
        SUM(total_tokens) AS totalTokens,
        SUM(total_prompt_tokens) AS totalPromptTokens,
        SUM(total_completion_tokens) AS totalCompletionTokens
      FROM app.token_use
    `)

  return {
    data: {
      totalTokens: Number(totalUsage?.totalTokens || 0),
      totalPromptTokens: Number(totalUsage?.totalPromptTokens || 0),
      totalCompletionTokens: Number(totalUsage?.totalCompletionTokens || 0),
    },
    error: null,
  }
}

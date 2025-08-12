import {apiClient} from '../../services/apiClient.ts'
import type {ExtendedDatabaseItemType} from '../getNewestArticles.ts'
import {colorizeJudgment, colorizeLogMessage} from './colorize.ts'
// import type {JudgmentResultType} from './judgeParseJudgment.ts'

// Helper that stores a validated judgment via RPC to our server and logs the outcome
export const judgeStoreJudgment = async (
  articleId: ExtendedDatabaseItemType['id'],
  articleTitle: string,
  judgment: Record<string, unknown>,
  modelId?: string,
  promptIds?: string[],
): Promise<void> => {
  try {
    // If we don't have modelId/promptIds, just log for now
    // This maintains backward compatibility while we transition
    if (!modelId || !promptIds || promptIds.length === 0) {
      const logMessage = `${articleId} | ${articleTitle}, ai: ${colorizeJudgment(judgment.article_judged_as_ai as string)}, ai agent: ${colorizeJudgment(judgment.article_judged_as_ai_agent as string)}, healthcare: ${colorizeJudgment(judgment.article_judged_as_healthcare as string)}`
      console.log(colorizeLogMessage(logMessage, judgment))
      console.warn(
        'Warning: No modelId/promptIds provided, judgment not stored to database',
      )
      return
    }
    // Store judgment for each prompt
    const storePromises = promptIds.map(async (promptId) => {
      const answers = Object.entries(judgment).filter(([key]) => {
        return key.includes(promptId)
      })
      const answeredOriginal = answers.find(([key]) => {
        //TODO: this is a hack to get the original answer
        return key.includes('---question')
      })[1] as string
      const answeredExplanation = answers.find(([key]) => {
        //TODO: this is a hack to get the original answer
        return key.includes('---explanation')
      })[1] as string
      const answeredQuotes: string[] = answers.find(([key]) => {
        //TODO: this is a hack to get the original answer
        return key.includes('---quotes')
      })[1] as string[]
      // ('test^^^a7aa21e8-d4e6-4e60-b39e-732085c56b00---explanation')
      // "test^^^a7aa21e8-d4e6-4e60-b39e-732085c56b00---quotes"

      // Using post request through Eden/Elysia RPC
      const response = await apiClient.api.judgments.store.post({
        articleId,
        modelId,
        promptId,
        answeredOriginal,
        answeredTransformed: undefined,
        confidenceOriginal: 50,
        explanation: answeredExplanation,
        quotes: answeredQuotes,
      })

      // Type guard for error checking
      if ('error' in response && response.error) {
        throw new Error(`API request failed: ${String(response.error)}`)
      }

      return response.data
    })
    // why is this here?
    const results = await Promise.allSettled(storePromises)

    const failedResults = results.filter((r): r is PromiseRejectedResult => {
      return r.status === 'rejected'
    })

    if (failedResults.length > 0) {
      console.error(
        `${articleId} | Failed to store ${failedResults.length} judgment(s) for article ${articleTitle}`,
        failedResults[0]?.reason,
      )
    } else {
      const logMessage = `${articleId} | ${articleTitle}, ai: ${colorizeJudgment(judgment.article_judged_as_ai as string)}, ai agent: ${colorizeJudgment(judgment.article_judged_as_ai_agent as string)}, healthcare: ${colorizeJudgment(judgment.article_judged_as_healthcare as string)}`
      console.log(colorizeLogMessage(logMessage, judgment))
    }
  } catch (error) {
    console.error(
      `${articleId} | Failed to store judgment for article ${articleTitle}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

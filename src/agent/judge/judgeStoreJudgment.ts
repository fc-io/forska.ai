import {type} from 'arktype'

import {apiClient} from '../../services/apiClient.ts'

// Extended database item type that includes judged_as fields
const _ExtendedDatabaseItem = type({
  id: 'string',

  article_authors: 'string',
  article_created: 'string',
  article_id: 'string',

  article_judged_as_ai_agent_explanation: 'string | null',
  article_judged_as_ai_agent_quote: 'string | null',
  article_judged_as_ai_agent: 'string',

  article_judged_as_ai_explanation: 'string | null',
  article_judged_as_ai_quote: 'string | null',
  article_judged_as_ai: 'string',

  article_judged_as_healthcare_explanation: 'string | null',
  article_judged_as_healthcare_quote: 'string[] | null',
  article_judged_as_healthcare: 'string',
  article_summary: 'string',
  article_title: 'string',
  article_updated: 'string',
  article_url: 'string | null',
  article_version: 'string',
  arxiv_id: 'string',
  created_at: 'string',
  doi: 'string | null',
  publication_status: 'string | null',
  pubmed_id: 'string | null',
  updated_at: 'string',
})

type ExtendedDatabaseItemType = typeof _ExtendedDatabaseItem.infer

const findAnswer = <T>(entries: [string, unknown][], fragment: string): T => {
  const match = entries.find(([key]) => {
    return key.includes(fragment)
  })

  if (!match) {
    throw new Error(`Missing ${fragment} answer`)
  }

  return match[1] as T
}

// Helper that stores a validated judgment via RPC to our server and logs the outcome
export const judgeStoreJudgment = async (
  articleId: ExtendedDatabaseItemType['id'],
  articleTitle: string,
  judgment: Record<string, unknown>,
  modelId: string,
  promptIds?: string[],
): Promise<void> => {
  try {
    if (!modelId || !promptIds || promptIds.length === 0) {
      console.error('Warning: No modelId/promptIds provided, judgment not stored to database')
      return
    }
    // Store judgment for each prompt
    const storePromises = promptIds.map(async (promptId) => {
      const answers = Object.entries(judgment).filter(([key]) => {
        return key.includes(promptId)
      })
      const answeredOriginal = findAnswer<string>(answers, '---question')
      const answeredExplanation = findAnswer<string>(answers, '---explanation')
      const answeredQuotes = findAnswer<string[]>(answers, '---quotes')
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
        throw new Error(`API request failed: ${JSON.stringify(response.error)}`)
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
    }
  } catch (error) {
    console.error(
      `${articleId} | Failed to store judgment for article ${articleTitle}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

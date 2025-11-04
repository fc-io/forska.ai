import {and, eq} from 'drizzle-orm'

import {judgments} from '../../db/schema.ts'

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
  articleId: string,
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
    const {getDatabase} = await import('../../server/utils/getDatabase.ts')
    const db = getDatabase()
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
      const existing = await db
        .select({id: judgments.id})
        .from(judgments)
        .where(
          and(eq(judgments.articleId, articleId), eq(judgments.modelId, modelId), eq(judgments.promptId, promptId)),
        )
        .limit(1)

      if (existing.length > 0) {
        const [updated] = await db
          .update(judgments)
          .set({
            isAnswered: true,
            answeredOriginal,
            answeredTransformed: null,
            confidenceOriginal: 50,
            explanation: answeredExplanation || null,
            quotes: answeredQuotes || null,
            updatedAt: new Date(),
          })
          .where(eq(judgments.id, existing[0].id))
          .returning()
        return updated
      }

      const [inserted] = await db
        .insert(judgments)
        .values({
          articleId,
          modelId,
          promptId,
          isAnswered: true,
          answeredOriginal,
          answeredTransformed: null,
          confidenceOriginal: 50,
          explanation: answeredExplanation || null,
          quotes: answeredQuotes || null,
        })
        .returning()
      return inserted
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

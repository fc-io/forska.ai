import {and, eq} from 'drizzle-orm'

import {judgments, models, projects} from '../../db/schema.ts'
import {getShortIdForPrompt, type ShortIdMapping} from './judgeGetPrompt.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'

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
  promptIds: string[] | undefined,
  projectId: string | undefined,
  shortIdMapping: ShortIdMapping,
): Promise<void> => {
  try {
    if (!modelId || !promptIds || promptIds.length === 0) {
      console.error('Warning: No modelId/promptIds provided, judgment not stored to database')
      return
    }
    const {getDatabase} = await import('../../server/utils/getDatabase.ts')
    const db = getDatabase()
    // Prepare snapshot context (best-effort)
    const [projectRow] =
      projectId && projectId.length > 0
        ? await db
            .select({
              id: projects.id,
              ownerId: projects.ownerId,
              useTitle: projects.useTitle,
              useAbstract: projects.useAbstract,
              useFulltext: projects.useFulltext,
            })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
        : [null]
    const [modelRow] = await db
      .select({modelName: models.modelName, provider: models.provider})
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1)
    const snapshotValues = {
      snapshotProjectId: projectRow?.id ?? null,
      snapshotProjectModelName: modelRow?.modelName ?? null,
    } as const
    // Store judgment for each prompt
    const storePromises = promptIds.map(async (promptId) => {
      // Use short ID to find the answers in the judgment object
      const shortId = getShortIdForPrompt(promptId, shortIdMapping)
      const answers = Object.entries(judgment).filter(([key]) => {
        return key.includes(shortId)
      })
      const answeredOriginal = findAnswer<string>(answers, '---question')
      const answeredExplanation = findAnswer<string>(answers, '---explanation')
      const answeredQuotes = findAnswer<string[]>(answers, '---quotes')
      // console.log('answeredOriginal', typeof answeredOriginal)
      // console.log(answeredOriginal)
      const answeredOriginalAsArray = judgeStoreJudgmentGetStringAsArrayOfStrings(answeredOriginal)
      // console.log('answeredOriginalAsArray', typeof answeredOriginalAsArray)
      // console.log(answeredOriginalAsArray)
      // ('test^^^a7aa21e8-d4e6-4e60-b39e-732085c56b00---explanation')
      // "test^^^a7aa21e8-d4e6-4e60-b39e-732085c56b00---quotes"
      const existing = await db
        .select({id: judgments.id})
        .from(judgments)
        .where(
          and(eq(judgments.articleId, articleId), eq(judgments.modelId, modelId), eq(judgments.promptId, promptId)),
        )
        .limit(1)

      const existingRow = existing[0]
      if (existingRow) {
        const existingId = existingRow.id
        const [updated] = await db
          .update(judgments)
          .set({
            isAnswered: true,
            answeredOriginal,
            answeredOriginalAsArray,
            confidenceOriginal: 50,
            explanation: answeredExplanation || null,
            quotes: answeredQuotes || null,
            updatedAt: new Date(),
          })
          .where(eq(judgments.id, existingId))
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
          answeredOriginalAsArray,
          confidenceOriginal: 50,
          explanation: answeredExplanation || null,
          quotes: answeredQuotes || null,
          // Snapshots (kept for cross-project display)
          snapshotProjectId: snapshotValues.snapshotProjectId,
          snapshotProjectModelName: snapshotValues.snapshotProjectModelName,
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

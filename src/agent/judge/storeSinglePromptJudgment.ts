import {and, eq} from 'drizzle-orm'

import {judgments, models, projects} from '../../db/schema.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'
import type {SinglePromptJudgmentResult} from './parseSinglePromptJudgment.ts'

/**
 * Stores a judgment for a single prompt.
 * Simplified version of judgeStoreJudgment for single-prompt processing.
 */
export const storeSinglePromptJudgment = async ({
  articleId,
  promptId,
  modelId,
  projectId,
  judgment,
}: {
  articleId: string
  promptId: string
  modelId: string
  projectId: string
  judgment: SinglePromptJudgmentResult
}): Promise<void> => {
  try {
    const {getDatabase} = await import('../../server/utils/getDatabase.ts')
    const db = getDatabase()

    // Prepare snapshot context (best-effort, only fetching fields we still store)
    const [projectRow] = await db.select({id: projects.id}).from(projects).where(eq(projects.id, projectId)).limit(1)

    const [modelRow] = await db
      .select({modelName: models.modelName, provider: models.provider})
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1)

    const snapshotValues = {
      snapshotProjectId: projectRow?.id ?? null,
      snapshotProjectModelName: modelRow?.modelName ?? null,
    } as const

    const rawAnswer = judgment.answer
    // Serialize array answers to JSON for the text column
    const answeredOriginal = Array.isArray(rawAnswer) ? JSON.stringify(rawAnswer) : rawAnswer
    const answeredOriginalAsArray = judgeStoreJudgmentGetStringAsArrayOfStrings(rawAnswer)
    const answeredExplanation = judgment.explanation
    const answeredQuotes = judgment.quotes

    // Check if judgment already exists
    const existing = await db
      .select({id: judgments.id})
      .from(judgments)
      .where(and(eq(judgments.articleId, articleId), eq(judgments.modelId, modelId), eq(judgments.promptId, promptId)))
      .limit(1)

    if (existing.length > 0) {
      const existingId = existing[0]?.id
      if (existingId) {
        await db
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
      }
    } else {
      await db.insert(judgments).values({
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
    }
  } catch (error) {
    console.error(
      `${articleId} | Failed to store judgment for prompt ${promptId}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
    throw error
  }
}

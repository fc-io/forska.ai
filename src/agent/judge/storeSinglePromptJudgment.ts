import {randomUUID} from 'crypto'
import {and, eq, isNull} from 'drizzle-orm'

import {articles, judgments, models, projects} from '../../db/schema.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'
import type {SinglePromptJudgmentResult} from './parseSinglePromptJudgment.ts'

/**
 * Stores a judgment for a single prompt.
 * Simplified version of judgeStoreJudgment for single-prompt processing.
 */
export const storeSinglePromptJudgment = async ({
  article,
  promptId,
  modelId,
  projectId,
  judgment,
  chunkingStrategy,
}: {
  article: typeof articles.$inferSelect
  promptId: string
  modelId: string
  projectId: string
  judgment: SinglePromptJudgmentResult
  chunkingStrategy: (typeof judgments.$inferInsert)['chunkingStrategy']
}): Promise<void> => {
  try {
    const {getDatabase} = await import('../../server/utils/getDatabase.ts')
    const db = getDatabase()

    // Prepare snapshot context (best-effort, only fetching fields we still store)
    const [projectRow] = await db
      .select({
        id: projects.id,
        useTitle: projects.useTitle,
        useAbstract: projects.useAbstract,
        useFulltext: projects.useFulltext,
        useFulltextNoImages: projects.useFulltextNoImages,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)

    const [modelRow] = await db
      .select({modelName: models.modelName, provider: models.provider})
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1)

    const useTitle = projectRow?.useTitle ?? true
    const useAbstract = projectRow?.useAbstract ?? true
    const useFulltext = projectRow?.useFulltext ?? false
    const useFulltextNoImages = projectRow?.useFulltextNoImages ?? false

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

    // Check if judgment already exists (must match full unique constraint including content config)
    const existing = await db
      .select({id: judgments.id, createdAt: judgments.createdAt})
      .from(judgments)
      .where(
        and(
          eq(judgments.articleId, article.id),
          eq(judgments.modelId, modelId),
          eq(judgments.promptId, promptId),
          eq(judgments.useTitle, useTitle),
          eq(judgments.useAbstract, useAbstract),
          eq(judgments.useFulltext, useFulltext),
          eq(judgments.useFulltextNoImages, useFulltextNoImages),
          isNull(judgments.deletedAt),
        ),
      )
      .limit(1)

    const existingId = existing[0]?.id ?? null
    const existingCreatedAt = existing[0]?.createdAt ?? null

    if (existingId) {
      // Immutable judgments: if it already exists, do not update.
      // To re-judge, the user must delete the existing judgment first.
      console.error(
        `${article.id} | Judgment already exists: promptId=${promptId}, modelId=${modelId}, `
          + `content=[T:${useTitle},A:${useAbstract},F:${useFulltext},FNI:${useFulltextNoImages}], `
          + `projectId=${projectId}, existingId=${existingId}, createdAt=${existingCreatedAt?.toISOString()}`,
      )
      return
    }

    const id = randomUUID()
    const createdAt = new Date()

    await db.insert(judgments).values({
      id,
      createdAt,
      updatedAt: createdAt,
      articleId: article.id,
      modelId,
      promptId,
      projectId,
      isAnswered: true,
      answeredOriginal,
      answeredOriginalAsArray: answeredOriginalAsArray ?? undefined,
      confidenceOriginal: 50,
      explanation: answeredExplanation || null,
      quotes: answeredQuotes ?? undefined,
      useTitle,
      useAbstract,
      useFulltext,
      useFulltextNoImages,
      chunkingStrategy,
      // Snapshots (kept for cross-project display)
      snapshotProjectId: snapshotValues.snapshotProjectId,
      snapshotProjectModelName: snapshotValues.snapshotProjectModelName,
    })
  } catch (error) {
    console.error(
      `${article.id} | Failed to store judgment for prompt ${promptId}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
    throw error
  }
}

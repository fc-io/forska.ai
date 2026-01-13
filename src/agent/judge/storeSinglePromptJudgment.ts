import {randomUUID} from 'crypto'
import {and, eq} from 'drizzle-orm'

import {articles, judgments, models, projects} from '../../db/schema.ts'
import type {DenormalizedJudgmentAnalytics} from '../../services/parquet'
import {writeJudgmentAnalyticsToParquet} from '../../services/parquet/judgmentsParquetDualWrite.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'
import type {SinglePromptJudgmentResult} from './parseSinglePromptJudgment.ts'

const getYearFromDate = (date: Date | null): number | null => {
  return date ? date.getUTCFullYear() : null
}

const getQuotesAsJsonString = (quotes: string[] | null): string | null => {
  return quotes ? JSON.stringify(quotes) : null
}

const buildDenormalizedJudgmentAnalyticsRecord = ({
  id,
  createdAt,
  article,
  promptId,
  modelId,
  useTitle,
  useAbstract,
  useFulltext,
  useFulltextNoImages,
  answeredOriginal,
  answeredOriginalAsArray,
  explanation,
  quotes,
}: {
  id: string
  createdAt: Date
  article: typeof articles.$inferSelect
  promptId: string
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  explanation: string | null
  quotes: string[] | null
}): DenormalizedJudgmentAnalytics => {
  return {
    id,
    createdAt,
    deletedAt: null,
    articleId: article.id,
    articleTitle: article.articleTitle,
    articleCreatedAt: article.articleCreatedAt,
    articleUpdatedAt: article.articleUpdatedAt,
    articleCreatedYear: getYearFromDate(article.articleCreatedAt),
    articleUpdatedYear: getYearFromDate(article.articleUpdatedAt),
    articleImportRoute: article.importRoute,
    articleImportedBy: article.importedBy,
    promptId,
    modelId,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
    answeredOriginal,
    answeredOriginalAsArray,
    explanation,
    quotes: getQuotesAsJsonString(quotes),
  }
}

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
}: {
  article: typeof articles.$inferSelect
  promptId: string
  modelId: string
  projectId: string
  judgment: SinglePromptJudgmentResult
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

    // Check if judgment already exists
    const existing = await db
      .select({id: judgments.id})
      .from(judgments)
      .where(and(eq(judgments.articleId, article.id), eq(judgments.modelId, modelId), eq(judgments.promptId, promptId)))
      .limit(1)

    const existingId = existing[0]?.id ?? null

    if (existingId) {
      // Immutable judgments: if it already exists, do not update.
      // To re-judge, the user must delete the existing judgment first.
      console.error(`${article.id} | Judgment already exists for prompt ${promptId}, skipping.`)
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
      answeredOriginalAsArray,
      confidenceOriginal: 50,
      explanation: answeredExplanation || null,
      quotes: answeredQuotes || null,
      useTitle,
      useAbstract,
      useFulltext,
      useFulltextNoImages,
      // Snapshots (kept for cross-project display)
      snapshotProjectId: snapshotValues.snapshotProjectId,
      snapshotProjectModelName: snapshotValues.snapshotProjectModelName,
    })

    const denormalizedRecord = buildDenormalizedJudgmentAnalyticsRecord({
      id,
      createdAt,
      article,
      promptId,
      modelId,
      useTitle,
      useAbstract,
      useFulltext,
      useFulltextNoImages,
      answeredOriginal,
      answeredOriginalAsArray,
      explanation: answeredExplanation || null,
      quotes: answeredQuotes,
    })

    await writeJudgmentAnalyticsToParquet(denormalizedRecord)
  } catch (error) {
    console.error(
      `${article.id} | Failed to store judgment for prompt ${promptId}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
    throw error
  }
}

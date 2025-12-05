import {and, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judgeSinglePrompt} from '../../../../agent/judge.ts'
import * as schema from '../../../../db/schema.ts'
import type {PromptToProcess} from './getAndUpdateReadyPrompts.ts'

type PromptDefinition = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}

const checkIfAlreadyJudged = async (
  db: PostgresJsDatabase<typeof schema>,
  articleId: string,
  modelId: string,
  promptId: string,
): Promise<boolean> => {
  const existingJudgment = await db
    .select({id: schema.judgments.id})
    .from(schema.judgments)
    .where(
      and(
        eq(schema.judgments.articleId, articleId),
        eq(schema.judgments.modelId, modelId),
        eq(schema.judgments.promptId, promptId),
        eq(schema.judgments.isAnswered, true),
      ),
    )
    .limit(1)

  return existingJudgment.length > 0
}

const processSinglePrompt = async (
  promptToProcess: PromptToProcess,
  article: typeof schema.articles.$inferSelect,
  prompt: PromptDefinition,
): Promise<void> => {
  const sessionId = null
  await judgeSinglePrompt({
    article,
    prompt,
    sessionId,
    judgmentsJobId: promptToProcess.jobId,
    modelConfig: {
      modelId: promptToProcess.modelId,
      modelName: promptToProcess.modelName,
      baseURL: promptToProcess.modelBaseUrl,
    },
    projectId: promptToProcess.projectId,
  })
}

const markAsJudged = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleId: string,
  promptId: string,
): Promise<void> => {
  await db
    .update(schema.judgmentsJobsPrompts)
    .set({status: 'judged', judgedAt: new Date(), updatedAt: new Date()})
    .where(
      and(
        eq(schema.judgmentsJobsPrompts.jobId, jobId),
        eq(schema.judgmentsJobsPrompts.articleId, articleId),
        eq(schema.judgmentsJobsPrompts.promptId, promptId),
      ),
    )
}

export const processPromptWithLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  promptToProcess: PromptToProcess,
): Promise<void> => {
  const [article] = await db
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.id, promptToProcess.articleId))
    .limit(1)

  if (!article) {
    console.error('Article not found:', promptToProcess.articleId)
    return
  }

  // Get the specific prompt to judge
  const [prompt] = await db
    .select({
      id: schema.prompts.id,
      originalText: schema.prompts.originalText,
      promptHeading: schema.prompts.promptHeading,
      order: schema.projectPrompts.order,
      type: schema.prompts.type,
    })
    .from(schema.prompts)
    .innerJoin(schema.projectPrompts, eq(schema.projectPrompts.promptId, schema.prompts.id))
    .where(
      and(
        eq(schema.prompts.id, promptToProcess.promptId),
        eq(schema.projectPrompts.projectId, promptToProcess.projectId),
        eq(schema.projectPrompts.enabled, true),
      ),
    )
    .limit(1)

  if (!prompt) {
    console.log('Prompt not found or not enabled:', promptToProcess.promptId)
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    return
  }

  // Check if this specific prompt has already been judged
  const alreadyJudged = await checkIfAlreadyJudged(
    db,
    promptToProcess.articleId,
    promptToProcess.modelId,
    promptToProcess.promptId,
  )

  if (alreadyJudged) {
    console.log('Prompt already judged for article:', {
      articleId: promptToProcess.articleId,
      promptId: promptToProcess.promptId,
    })
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    return
  }

  // Process the single prompt
  console.log(`Processing prompt ${promptToProcess.promptId} for article ${promptToProcess.articleId}`)

  try {
    await processSinglePrompt(promptToProcess, article, prompt)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('Failed to process prompt for article:', {
      articleId: promptToProcess.articleId,
      promptId: promptToProcess.promptId,
      error: errorMessage,
    })
  }

  await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
}

import {and, eq, inArray} from 'drizzle-orm'
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

const getExistingJudgmentPromptIds = async (
  db: PostgresJsDatabase<typeof schema>,
  articleId: string,
  modelId: string,
  promptIds: string[],
): Promise<Set<string>> => {
  if (promptIds.length === 0) return new Set()

  const existingJudgments = await db
    .select({promptId: schema.judgments.promptId})
    .from(schema.judgments)
    .where(
      and(
        eq(schema.judgments.articleId, articleId),
        eq(schema.judgments.modelId, modelId),
        inArray(schema.judgments.promptId, promptIds),
        eq(schema.judgments.isAnswered, true),
      ),
    )

  return new Set(
    existingJudgments.map((j) => {
      return j.promptId
    }),
  )
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

const markAsJudged = async (db: PostgresJsDatabase<typeof schema>, jobId: string, articleId: string): Promise<void> => {
  await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'judged', judgedAt: new Date(), updatedAt: new Date()})
    .where(and(eq(schema.judgmentsJobsArticles.jobId, jobId), eq(schema.judgmentsJobsArticles.articleId, articleId)))
}

const processPromptsForQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  promptToProcess: PromptToProcess,
  article: typeof schema.articles.$inferSelect,
  promptsToJudge: PromptDefinition[],
  allPromptsCount: number,
  existingCount: number,
): Promise<void> => {
  console.log(
    `Processing ${promptsToJudge.length}/${allPromptsCount} prompts for article ${promptToProcess.articleId} (${existingCount} already judged)`,
  )

  const results = await Promise.allSettled(
    promptsToJudge.map((prompt) => {
      return processSinglePrompt(promptToProcess, article, prompt)
    }),
  )

  const failed = results.filter((r): r is PromiseRejectedResult => {
    return r.status === 'rejected'
  })

  if (failed.length > 0) {
    const errorReasons = failed.map((r) => {
      const reason: unknown = r.reason
      return reason instanceof Error ? reason.message : String(reason)
    })
    console.error(`Failed to process ${failed.length}/${promptsToJudge.length} prompts for article:`, {
      articleId: promptToProcess.articleId,
      errors: errorReasons,
    })
  }

  await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId)
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

  const allPrompts = await db
    .select({
      id: schema.prompts.id,
      originalText: schema.prompts.originalText,
      promptHeading: schema.prompts.promptHeading,
      order: schema.projectPrompts.order,
      type: schema.prompts.type,
    })
    .from(schema.projectPrompts)
    .innerJoin(schema.prompts, eq(schema.projectPrompts.promptId, schema.prompts.id))
    .where(and(eq(schema.projectPrompts.projectId, promptToProcess.projectId), eq(schema.projectPrompts.enabled, true)))
    .orderBy(schema.projectPrompts.order)

  if (allPrompts.length === 0) {
    console.log('No prompts to process for article:', promptToProcess.articleId)
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId)
    return
  }

  const promptIds = allPrompts.map((p) => {
    return p.id
  })
  const existingJudgmentPromptIds = await getExistingJudgmentPromptIds(
    db,
    promptToProcess.articleId,
    promptToProcess.modelId,
    promptIds,
  )

  const promptsToJudge = allPrompts.filter((p) => {
    return !existingJudgmentPromptIds.has(p.id)
  })

  if (promptsToJudge.length === 0) {
    console.log('All prompts already judged for article:', promptToProcess.articleId)
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId)
    return
  }

  await processPromptsForQueue(
    db,
    promptToProcess,
    article,
    promptsToJudge,
    allPrompts.length,
    existingJudgmentPromptIds.size,
  )
}

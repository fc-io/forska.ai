import {and, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judgeSinglePrompt} from '../../../../agent/judge.ts'
import * as schema from '../../../../db/schema.ts'
import {markArticlesAsJudged} from '../judgmentsJobsArticlesRepository.ts'
import type {ArticleToProcess} from './getAndUpdateReadyArticles.ts'

type PromptToProcess = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}

/**
 * Get the IDs of prompts that already have judgments for this article+model combination.
 * We skip these prompts to avoid re-sending them to the LLM.
 */
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

/**
 * Process a single prompt for an article.
 */
const processSinglePrompt = async (
  articleToProcess: ArticleToProcess,
  article: typeof schema.articles.$inferSelect,
  prompt: PromptToProcess,
): Promise<void> => {
  const sessionId = null
  await judgeSinglePrompt({
    article,
    prompt,
    sessionId,
    judgmentsJobId: articleToProcess.jobId,
    modelConfig: {
      modelId: articleToProcess.modelId,
      modelName: articleToProcess.modelName,
      baseURL: articleToProcess.modelBaseUrl,
    },
    projectId: articleToProcess.projectId,
  })
}

export const processArticleWithLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  articleToProcess: ArticleToProcess,
): Promise<void> => {
  const [article] = await db
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.id, articleToProcess.articleId))
    .limit(1)

  if (!article) {
    console.error('Article not found:', articleToProcess.articleId)
    return
  }

  // Get all enabled prompts for the project
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
    .where(
      and(eq(schema.projectPrompts.projectId, articleToProcess.projectId), eq(schema.projectPrompts.enabled, true)),
    )
    .orderBy(schema.projectPrompts.order)

  if (allPrompts.length === 0) {
    console.log('No prompts to process for article:', articleToProcess.articleId)
    await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
    return
  }

  // Filter out prompts that already have judgments
  const promptIds = allPrompts.map((p) => {
    return p.id
  })
  const existingJudgmentPromptIds = await getExistingJudgmentPromptIds(
    db,
    articleToProcess.articleId,
    articleToProcess.modelId,
    promptIds,
  )

  const promptsToProcess = allPrompts.filter((p) => {
    return !existingJudgmentPromptIds.has(p.id)
  })

  if (promptsToProcess.length === 0) {
    console.log('All prompts already judged for article:', articleToProcess.articleId)
    await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
    return
  }

  console.log(
    `Processing ${promptsToProcess.length}/${allPrompts.length} prompts for article ${articleToProcess.articleId} (${existingJudgmentPromptIds.size} already judged)`,
  )

  // Process each prompt individually
  const results = await Promise.allSettled(
    promptsToProcess.map((prompt) => {
      return processSinglePrompt(articleToProcess, article, prompt)
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
    console.error(`Failed to process ${failed.length}/${promptsToProcess.length} prompts for article:`, {
      articleId: articleToProcess.articleId,
      errors: errorReasons,
    })
  }

  // Mark the article as judged after all prompts are processed
  await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
}

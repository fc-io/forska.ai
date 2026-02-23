import {and, eq, isNull} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judgeSinglePrompt} from '../../../../agent/judge.ts'
import * as schema from '../../../../db/schema.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'
import {env} from '../../../utils/env.ts'
import {processFulltextForLLM} from '../../../utils/fulltextProcessing.ts'
import {createRateLimitedLogger, rateLimitedLogger} from '../../../utils/rateLimitedLogger.ts'
import {ConnectionError} from '../connectionHealth.ts'
import type {PromptToProcess} from './getAndUpdateReadyPrompts.ts'

const checkJudgmentExistsInPostgres = async (
  db: PostgresJsDatabase<typeof schema>,
  promptToProcess: PromptToProcess,
): Promise<boolean> => {
  const [existing] = await db
    .select({id: schema.judgments.id})
    .from(schema.judgments)
    .where(
      and(
        eq(schema.judgments.articleId, promptToProcess.articleId),
        eq(schema.judgments.promptId, promptToProcess.promptId),
        eq(schema.judgments.modelId, promptToProcess.modelId),
        eq(schema.judgments.useTitle, promptToProcess.useTitle),
        eq(schema.judgments.useAbstract, promptToProcess.useAbstract),
        eq(schema.judgments.useFulltext, promptToProcess.useFulltext),
        eq(schema.judgments.useFulltextNoImages, promptToProcess.useFulltextNoImages),
        isNull(schema.judgments.deletedAt),
      ),
    )
    .limit(1)
  return Boolean(existing)
}

type PromptDefinition = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
}

const processPromptLogger = createRateLimitedLogger({windowMs: 30_000})

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
      provider: promptToProcess.modelProvider,
      version: promptToProcess.modelVersion,
    },
    projectId: promptToProcess.projectId,
    contentSettings: {
      useTitle: promptToProcess.useTitle,
      useAbstract: promptToProcess.useAbstract,
      useFulltext: promptToProcess.useFulltext,
      useFulltextNoImages: promptToProcess.useFulltextNoImages,
    },
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

/**
 * Reset a prompt back to 'pending' so it can be retried on the next cron cycle.
 * Used when connection errors occur - the prompt is not permanently failed.
 */
const markAsRetry = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleId: string,
  promptId: string,
): Promise<void> => {
  await db
    .update(schema.judgmentsJobsPrompts)
    .set({status: 'ready', updatedAt: new Date()})
    .where(
      and(
        eq(schema.judgmentsJobsPrompts.jobId, jobId),
        eq(schema.judgmentsJobsPrompts.articleId, articleId),
        eq(schema.judgmentsJobsPrompts.promptId, promptId),
      ),
    )
}

/**
 * Mark a prompt as skipped when fulltext is required but unavailable.
 * This is a terminal state - the prompt will not be retried.
 */
const markAsSkipped = async (
  db: PostgresJsDatabase<typeof schema>,
  jobId: string,
  articleId: string,
  promptId: string,
  skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large',
): Promise<void> => {
  await db
    .update(schema.judgmentsJobsPrompts)
    .set({status: 'skipped', skipReason, updatedAt: new Date()})
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
  const startTime = Date.now()
  const judgmentExists = await checkJudgmentExistsInPostgres(db, promptToProcess)
  if (judgmentExists) {
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    console.log('[llm] Skipped - judgment already exists for:', promptToProcess.articleId.slice(0, 8))
    return
  }

  const [article] = await db
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.id, promptToProcess.articleId))
    .limit(1)

  if (!article) {
    console.error('Article not found:', promptToProcess.articleId)
    // Mark as judged to prevent getting stuck in 'sent' status
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    return
  }

  // Handle fulltext requirement for projects with useFulltext=true or useFulltextNoImages=true
  // Create a mutable article object that we can update with fulltext if needed
  let articleWithFulltext = article
  const needsFulltext = promptToProcess.useFulltext || promptToProcess.useFulltextNoImages
  if (needsFulltext) {
    const result = await ensureFullText(db, article, article.id)

    if (!result.text) {
      if (result.shouldSkip) {
        // Permanent failure or no PDF → mark as skipped (terminal)
        rateLimitedLogger.log(
          `fulltext:skip:${result.reason}`,
          `[fulltext] Skipping article ${article.id}: ${result.reason}`,
        )
        await markAsSkipped(
          db,
          promptToProcess.jobId,
          promptToProcess.articleId,
          promptToProcess.promptId,
          result.reason,
        )
        return
      } else {
        // Transient failure → requeue for later retry
        console.log(
          `[fulltext] Transient failure for article ${article.id}, requeuing prompt ${promptToProcess.promptId}`,
        )
        await markAsRetry(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
        return
      }
    }

    // Process fulltext: optionally strip images and check token budget
    // Use SGLANG_CONTEXT_LENGTH if available (> 0), otherwise fall back to default
    const modelContext = env.SGLANG_CONTEXT_LENGTH > 0 ? env.SGLANG_CONTEXT_LENGTH : undefined
    const processResult = processFulltextForLLM(result.text, {
      stripImages: promptToProcess.useFulltextNoImages,
      modelContext,
    })
    if (!processResult.success) {
      // Token budget exceeded → mark as skipped
      console.log(
        `[fulltext] Skipping article ${article.id}: fulltext too large (${processResult.tokenCount.toLocaleString()} tokens, max: ${processResult.maxTokens.toLocaleString()})`,
      )
      await markAsSkipped(
        db,
        promptToProcess.jobId,
        promptToProcess.articleId,
        promptToProcess.promptId,
        'fulltext_too_large',
      )
      return
    }

    // Update the article object with the processed fulltext for use in prompt generation
    articleWithFulltext = {...article, fullText: processResult.processedText}
  }

  const articleForJudging = needsFulltext ? articleWithFulltext : {...article, fullText: null}

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
  // Process the single prompt
  // console.log(`Processing prompt ${promptToProcess.promptId} for article ${promptToProcess.articleId}`)

  try {
    processPromptLogger.log(
      `llm:calling:${promptToProcess.modelBaseUrl}`,
      '[llm] Calling LLM for article:',
      promptToProcess.articleId.slice(0, 8),
    )
    await processSinglePrompt(promptToProcess, articleForJudging, prompt)
    // Success - mark as judged
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    const duration = Date.now() - startTime
    processPromptLogger.log(`llm:success:${promptToProcess.modelBaseUrl}`, `[llm] Success - processed in ${duration}ms`)
  } catch (error) {
    // Check if this is a connection error - if so, don't mark as judged
    // The prompt will be retried on the next cron cycle when the server is back up
    if (error instanceof ConnectionError) {
      rateLimitedLogger.log(
        `prompt:retry:${promptToProcess.modelBaseUrl}`,
        `Connection error - marking prompts for retry (${promptToProcess.modelBaseUrl})`,
      )
      await markAsRetry(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
      // Re-throw to let the caller know there was a connection issue
      throw error
    }

    // For other errors, log and mark as judged to prevent infinite loops
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[llm] ERROR - Failed to process prompt:', {
      articleId: promptToProcess.articleId,
      promptId: promptToProcess.promptId,
      error: errorMessage,
    })
    await markAsJudged(db, promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
  }
}

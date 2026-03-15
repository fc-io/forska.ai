import {judgeSinglePrompt} from '../../../../agent/judge.ts'
import * as schema from '../../../../db/schema.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../../services/getAppQueryService.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'
import {env} from '../../../utils/env.ts'
import {processFulltextForLLM} from '../../../utils/fulltextProcessing.ts'
import {createRateLimitedLogger, rateLimitedLogger} from '../../../utils/rateLimitedLogger.ts'
import {ConnectionError} from '../connectionHealth.ts'
import type {PromptToProcess} from './getAndUpdateReadyPrompts.ts'

const checkJudgmentExistsInDatabase = async (promptToProcess: PromptToProcess): Promise<boolean> => {
  const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = '${escapeSqlString(promptToProcess.articleId)}'
      AND prompt_id = '${escapeSqlString(promptToProcess.promptId)}'
      AND model_id = '${escapeSqlString(promptToProcess.modelId)}'
      AND use_title = ${promptToProcess.useTitle ? 'TRUE' : 'FALSE'}
      AND use_abstract = ${promptToProcess.useAbstract ? 'TRUE' : 'FALSE'}
      AND use_fulltext = ${promptToProcess.useFulltext ? 'TRUE' : 'FALSE'}
      AND use_fulltext_no_images = ${promptToProcess.useFulltextNoImages ? 'TRUE' : 'FALSE'}
      AND deleted_at IS NULL
    LIMIT 1
  `)
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

const DEFAULT_MODEL_CONTEXT = 32768

const normalizeProvider = (value: string | null | undefined): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  return v.length > 0 ? v : 'unknown'
}

const getModelContextForProvider = (provider: string | null | undefined): number => {
  const normalized = normalizeProvider(provider)
  const fromEnv = normalized === 'codex' ? env.CODEX_CONTEXT_LENGTH : env.SGLANG_CONTEXT_LENGTH
  return fromEnv > 0 ? fromEnv : DEFAULT_MODEL_CONTEXT
}

const processSinglePrompt = async (
  promptToProcess: PromptToProcess,
  article: typeof schema.articles.$inferSelect,
  prompt: PromptDefinition,
  modelContext: number,
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
    modelContext,
    projectId: promptToProcess.projectId,
    contentSettings: {
      useTitle: promptToProcess.useTitle,
      useAbstract: promptToProcess.useAbstract,
      useFulltext: promptToProcess.useFulltext,
      useFulltextNoImages: promptToProcess.useFulltextNoImages,
    },
  })
}

const markAsJudged = async (jobId: string, articleId: string, promptId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job_prompt
    SET status = 'judged',
        judged_at = current_timestamp,
        updated_at = current_timestamp
    WHERE job_id = '${escapeSqlString(jobId)}'
      AND article_id = '${escapeSqlString(articleId)}'
      AND prompt_id = '${escapeSqlString(promptId)}'
  `)
}

/**
 * Reset a prompt back to 'pending' so it can be retried on the next cron cycle.
 * Used when connection errors occur - the prompt is not permanently failed.
 */
const markAsRetry = async (jobId: string, articleId: string, promptId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job_prompt
    SET status = 'ready',
        updated_at = current_timestamp
    WHERE job_id = '${escapeSqlString(jobId)}'
      AND article_id = '${escapeSqlString(articleId)}'
      AND prompt_id = '${escapeSqlString(promptId)}'
  `)
}

/**
 * Mark a prompt as skipped when fulltext is required but unavailable.
 * This is a terminal state - the prompt will not be retried.
 */
const markAsSkipped = async (
  jobId: string,
  articleId: string,
  promptId: string,
  skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large',
): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job_prompt
    SET status = 'skipped',
        skip_reason = ${getSqlLiteral(skipReason)},
        updated_at = current_timestamp
    WHERE job_id = '${escapeSqlString(jobId)}'
      AND article_id = '${escapeSqlString(articleId)}'
      AND prompt_id = '${escapeSqlString(promptId)}'
  `)
}

export const processPromptWithLLM = async (promptToProcess: PromptToProcess): Promise<void> => {
  const startTime = Date.now()
  const modelContext = getModelContextForProvider(promptToProcess.modelProvider)
  const judgmentExists = await checkJudgmentExistsInDatabase(promptToProcess)
  if (judgmentExists) {
    await markAsJudged(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    console.log('[llm] Skipped - judgment already exists for:', promptToProcess.articleId.slice(0, 8))
    return
  }

  const [article] = await getAppQueryService().getFullArticlesByIds([promptToProcess.articleId])

  if (!article) {
    console.error('Article not found:', promptToProcess.articleId)
    // Mark as judged to prevent getting stuck in 'sent' status
    await markAsJudged(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
    return
  }

  // Handle fulltext requirement for projects with useFulltext=true or useFulltextNoImages=true
  // Create a mutable article object that we can update with fulltext if needed
  let articleWithFulltext: typeof schema.articles.$inferSelect = {
    ...article,
    createdAt: article.createdAt ?? new Date(0),
    updatedAt: article.updatedAt ?? new Date(0),
    publicationStatus: article.publicationStatus as (typeof schema.articles.$inferSelect)['publicationStatus'],
  }
  const needsFulltext = promptToProcess.useFulltext || promptToProcess.useFulltextNoImages
  if (needsFulltext) {
    const result = await ensureFullText(articleWithFulltext, article.id)

    if (!result.text) {
      if (result.shouldSkip) {
        // Permanent failure or no PDF → mark as skipped (terminal)
        rateLimitedLogger.log(
          `fulltext:skip:${result.reason}`,
          `[fulltext] Skipping article ${article.id}: ${result.reason}`,
        )
        await markAsSkipped(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId, result.reason)
        return
      } else {
        // Transient failure → requeue for later retry
        console.log(
          `[fulltext] Transient failure for article ${article.id}, requeuing prompt ${promptToProcess.promptId}`,
        )
        await markAsRetry(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
        return
      }
    }

    // Process fulltext: optionally strip images. Chunking happens later during judging.
    const processResult = processFulltextForLLM(result.text, {
      stripImages: promptToProcess.useFulltextNoImages,
      modelContext,
    })

    if (!processResult.withinBudget) {
      rateLimitedLogger.log(
        'fulltext:large:chunked-mode',
        `[fulltext] Large fulltext for ${article.id}: ~${processResult.tokenCount.toLocaleString()} tokens (max ~${processResult.maxTokens.toLocaleString()}); will rely on chunked judging`,
      )
    }

    // Update the article object with the processed fulltext for use in prompt generation
    articleWithFulltext = {...articleWithFulltext, fullText: processResult.processedText}
  }

  const articleForJudging = needsFulltext ? articleWithFulltext : {...articleWithFulltext, fullText: null}

  // Get the specific prompt to judge
  const [prompt] = await getAppDatabaseService().queryJson<PromptDefinition>(`
    SELECT
      p.id AS id,
      p.original_text AS originalText,
      p.prompt_heading AS promptHeading,
      pp.prompt_order AS "order",
      p.type AS type
    FROM app.prompt p
    INNER JOIN app.project_prompt pp ON pp.prompt_id = p.id
    WHERE p.id = '${escapeSqlString(promptToProcess.promptId)}'
      AND pp.project_id = '${escapeSqlString(promptToProcess.projectId)}'
      AND pp.enabled = TRUE
    LIMIT 1
  `)

  if (!prompt) {
    console.log('Prompt not found or not enabled:', promptToProcess.promptId)
    await markAsJudged(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
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
    await processSinglePrompt(promptToProcess, articleForJudging, prompt, modelContext)
    // Success - mark as judged
    await markAsJudged(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
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
      await markAsRetry(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
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
    await markAsJudged(promptToProcess.jobId, promptToProcess.articleId, promptToProcess.promptId)
  }
}

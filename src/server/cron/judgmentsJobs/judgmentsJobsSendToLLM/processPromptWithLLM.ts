import {judgeSinglePrompt} from '../../../../agent/judge.ts'
import {JudgmentPersistenceError} from '../../../../agent/judge/storeSinglePromptJudgment.ts'
import type {ArticleRecord, PublicationStatus} from '../../../../db/schemaTypes.ts'
import {getProviderModelMetadataContextLength} from '../../../providers/providerModelMetadata.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getAppQueryService} from '../../../services/getAppQueryService.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'
import {processFulltextForLLM} from '../../../utils/fulltextProcessing.ts'
import {createRateLimitedLogger, rateLimitedLogger} from '../../../utils/rateLimitedLogger.ts'
import {ConnectionError} from '../connectionHealth.ts'
import {getJudgmentJobSqliteService} from '../judgmentJobSqliteService.ts'
import type {PromptToProcess} from './getAndUpdateReadyPrompts.ts'

const checkJudgmentExistsInDatabase = async (promptToProcess: PromptToProcess): Promise<boolean> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (sqliteService.hasJob(promptToProcess.jobId)) {
    const hasLocalJudgment = await sqliteService.hasLocalJudgment(
      promptToProcess.jobId,
      promptToProcess.articleId,
      promptToProcess.promptId,
    )

    if (hasLocalJudgment) {
      return true
    }
  }

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

type PreparedPrompt = {articleForJudging: ArticleRecord; prompt: PromptDefinition} | null

type PromptPreparationWaiter = {resolve: (release: () => void) => void}

const processPromptLogger = createRateLimitedLogger({windowMs: 30_000})

const DEFAULT_MODEL_CONTEXT = 32768
const promptPreparationMaxInFlight = 16

const promptPreparationWaiters: PromptPreparationWaiter[] = []

let promptPreparationInFlight = 0

const getModelContext = (metadataJson: unknown): number => {
  return getProviderModelMetadataContextLength(metadataJson) ?? DEFAULT_MODEL_CONTEXT
}

const releasePromptPreparationSlot = (): void => {
  const nextWaiter = promptPreparationWaiters.shift()

  if (nextWaiter) {
    nextWaiter.resolve(() => {
      releasePromptPreparationSlot()
    })
    return
  }

  promptPreparationInFlight = Math.max(0, promptPreparationInFlight - 1)
}

const acquirePromptPreparationSlot = async (): Promise<() => void> => {
  if (promptPreparationInFlight < promptPreparationMaxInFlight) {
    promptPreparationInFlight += 1
    return () => {
      releasePromptPreparationSlot()
    }
  }

  return new Promise((resolve) => {
    promptPreparationWaiters.push({resolve})
  })
}

const withPromptPreparationPermit = async <T>(work: () => Promise<T>): Promise<T> => {
  const release = await acquirePromptPreparationSlot()

  try {
    return await work()
  } finally {
    release()
  }
}

const processSinglePrompt = async (
  promptToProcess: PromptToProcess,
  article: ArticleRecord,
  prompt: PromptDefinition,
  modelContext: number,
): Promise<void> => {
  const sessionId = null
  await judgeSinglePrompt({
    article,
    prompt,
    queueRecordId: promptToProcess.recordId,
    sessionId,
    judgmentsJobId: promptToProcess.jobId,
    modelConfig: {
      modelId: promptToProcess.modelId,
      modelName: promptToProcess.modelName,
      baseURL: promptToProcess.modelBaseUrl,
      provider: promptToProcess.modelProvider,
      providerConnectionId: promptToProcess.providerConnectionId,
      providerMaxInflightRequests: promptToProcess.providerMaxInflightRequests,
      workerUrls: promptToProcess.modelWorkerUrls,
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

const markAsJudged = async (jobId: string, recordId: string): Promise<void> => {
  await getJudgmentJobSqliteService().markPromptAsJudged(jobId, recordId)
}

/**
 * Reset a prompt back to 'pending' so it can be retried on the next cron cycle.
 * Used when connection errors occur - the prompt is not permanently failed.
 */
const markAsRetry = async (jobId: string, recordId: string): Promise<void> => {
  await getJudgmentJobSqliteService().markPromptAsRetry(jobId, recordId)
}

/**
 * Mark a prompt as skipped when fulltext is required but unavailable.
 * This is a terminal state - the prompt will not be retried.
 */
const markAsSkipped = async (
  jobId: string,
  recordId: string,
  skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large',
): Promise<void> => {
  await getJudgmentJobSqliteService().markPromptAsSkipped(jobId, recordId, skipReason)
}

const preparePrompt = async (promptToProcess: PromptToProcess, modelContext: number): Promise<PreparedPrompt> => {
  const judgmentExists = await checkJudgmentExistsInDatabase(promptToProcess)
  if (judgmentExists) {
    await markAsJudged(promptToProcess.jobId, promptToProcess.recordId)
    console.log('[llm] Skipped - judgment already exists for:', promptToProcess.articleId.slice(0, 8))
    return null
  }

  const needsFulltext = promptToProcess.useFulltext || promptToProcess.useFulltextNoImages
  const [article] = await getAppQueryService().getFullArticlesByIds([promptToProcess.articleId], {
    includeFullText: needsFulltext,
  })

  if (!article) {
    console.error('Article not found:', promptToProcess.articleId)
    await markAsJudged(promptToProcess.jobId, promptToProcess.recordId)
    return null
  }

  let articleWithFulltext = {
    ...article,
    createdAt: article.createdAt ?? new Date(0),
    updatedAt: article.updatedAt ?? new Date(0),
    publicationStatus: article.publicationStatus as PublicationStatus | null,
  } as ArticleRecord

  if (needsFulltext) {
    const result = await ensureFullText(articleWithFulltext, article.id)

    if (!result.text) {
      return result.shouldSkip
        ? (() => {
            rateLimitedLogger.log(
              `fulltext:skip:${result.reason}`,
              `[fulltext] Skipping article ${article.id}: ${result.reason}`,
            )
            return markAsSkipped(promptToProcess.jobId, promptToProcess.recordId, result.reason)
          })().then(() => {
            return null
          })
        : (() => {
            console.log(
              `[fulltext] Transient failure for article ${article.id}, requeuing prompt ${promptToProcess.promptId}`,
            )
            return markAsRetry(promptToProcess.jobId, promptToProcess.recordId)
          })().then(() => {
            return null
          })
    }

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

    articleWithFulltext = {...articleWithFulltext, fullText: processResult.processedText}
  }

  const articleForJudging = needsFulltext ? articleWithFulltext : {...articleWithFulltext, fullText: null}
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
    await markAsJudged(promptToProcess.jobId, promptToProcess.recordId)
    return null
  }

  return {articleForJudging, prompt}
}

export const processPromptWithLLM = async (promptToProcess: PromptToProcess): Promise<void> => {
  const startTime = Date.now()
  const modelContext = getModelContext(promptToProcess.modelMetadataJson)
  const prepared = await withPromptPreparationPermit(() => {
    return preparePrompt(promptToProcess, modelContext)
  })

  if (!prepared) {
    return
  }

  try {
    processPromptLogger.log(
      `llm:calling:${promptToProcess.modelBaseUrl}`,
      '[llm] Calling LLM for article:',
      promptToProcess.articleId.slice(0, 8),
    )
    await processSinglePrompt(promptToProcess, prepared.articleForJudging, prepared.prompt, modelContext)
    await markAsJudged(promptToProcess.jobId, promptToProcess.recordId)
    const duration = Date.now() - startTime
    processPromptLogger.log(`llm:success:${promptToProcess.modelBaseUrl}`, `[llm] Success - processed in ${duration}ms`)
  } catch (error) {
    if (error instanceof ConnectionError) {
      rateLimitedLogger.log(
        `prompt:retry:${promptToProcess.modelBaseUrl}`,
        `Connection error - marking prompts for retry (${promptToProcess.modelBaseUrl})`,
      )
      await markAsRetry(promptToProcess.jobId, promptToProcess.recordId)
      throw error
    }

    if (error instanceof JudgmentPersistenceError) {
      await markAsRetry(promptToProcess.jobId, promptToProcess.recordId)
      throw error
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[llm] ERROR - Failed to process prompt:', {
      articleId: promptToProcess.articleId,
      promptId: promptToProcess.promptId,
      error: errorMessage,
    })
    await markAsJudged(promptToProcess.jobId, promptToProcess.recordId)
  }
}

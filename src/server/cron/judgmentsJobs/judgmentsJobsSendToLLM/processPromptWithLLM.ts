import {Effect} from 'effect'

import {judgeSinglePrompt, MAX_COMPLETION_TOKENS, RecoverableJudgeError} from '../../../../agent/judge.ts'
import {JudgmentPersistenceError} from '../../../../agent/judge/storeSinglePromptJudgment.ts'
import type {ArticleRecord, PublicationStatus} from '../../../../db/schemaTypes.ts'
import {getProviderModelMetadataPromptTokenLimit} from '../../../providers/providerModelMetadata.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {getJudgeWorkerReadOnlyAppQueryService} from '../../../services/getAppReadOnlyQueryService.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'
import {processFulltextForLLM} from '../../../utils/fulltextProcessing.ts'
import {createRateLimitedLogger} from '../../../utils/rateLimitedLogger.ts'
import {ConnectionError, formatConnectionOutageMessage} from '../connectionHealth.ts'
import {
  enqueueJudgeWorkerCompletion,
  flushJudgeWorkerCompletionOutboxForClaim,
  hasUnackedJudgeWorkerCompletion,
  shouldUseJudgeWorkerOwnerHandoff,
} from '../judgeWorkerCompletionJournal.ts'
import {getJudgmentEndpointAvailability} from '../judgmentEndpointAvailability.ts'
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

  const [existing] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
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

type PreparedPromptResult =
  | {kind: 'judged'}
  | {kind: 'ready'}
  | {kind: 'run'; articleForJudging: ArticleRecord; prompt: PromptDefinition}
  | {kind: 'skipped'; skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large'}

type PromptPreparationWaiter = {resolve: (release: () => void) => void}

type PromptTerminalState =
  | {kind: 'judged'}
  | {kind: 'ready'; retryAfterMs: number | null}
  | {kind: 'skipped'; skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large'}

const processPromptLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const processPromptFailureLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const processPromptComponent = 'processPromptWithLLM'
const cachedArticleLookups = new Map<string, Promise<ArticleRecord | null>>()
const cachedPromptLookups = new Map<string, Promise<PromptDefinition | null>>()

const DEFAULT_MODEL_CONTEXT = 32768
const DEFAULT_PROMPT_TOKEN_LIMIT = Math.max(0, DEFAULT_MODEL_CONTEXT - MAX_COMPLETION_TOKENS)
const maxRecoverablePromptExtraRetries = 1
const promptPreparationMaxInFlight = 16

const promptPreparationWaiters: PromptPreparationWaiter[] = []

let promptPreparationInFlight = 0

const getModelContext = (metadataJson: unknown): number => {
  return getProviderModelMetadataPromptTokenLimit(metadataJson, MAX_COMPLETION_TOKENS) ?? DEFAULT_PROMPT_TOKEN_LIMIT
}

const trimCachedLookups = <T>(cache: Map<string, Promise<T>>, maxSize: number): void => {
  return cache.size <= maxSize
    ? undefined
    : (cache.delete(cache.keys().next().value as string), trimCachedLookups(cache, maxSize))
}

const withCachedLookup = async <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
  const existing = cache.get(key)

  if (existing) {
    return existing
  }

  const pending = load().catch((error) => {
    cache.delete(key)
    throw error
  })

  cache.set(key, pending)
  trimCachedLookups(cache, 5000)

  return pending
}

const getCachedArticle = async ({
  articleId,
  includeFullText,
}: {
  articleId: string
  includeFullText: boolean
}): Promise<ArticleRecord | null> => {
  const cacheKey = `${articleId}:${includeFullText ? 'fulltext' : 'metadata'}`

  return withCachedLookup(cachedArticleLookups, cacheKey, async () => {
    const [article] = await getJudgeWorkerReadOnlyAppQueryService().getFullArticlesByIds([articleId], {includeFullText})

    return article
      ? ({
          ...article,
          createdAt: article.createdAt ?? new Date(0),
          updatedAt: article.updatedAt ?? new Date(0),
          publicationStatus: article.publicationStatus as PublicationStatus | null,
        } as ArticleRecord)
      : null
  })
}

const getCachedPromptDefinition = async ({
  projectId,
  promptId,
}: {
  projectId: string
  promptId: string
}): Promise<PromptDefinition | null> => {
  const cacheKey = `${projectId}:${promptId}`

  return withCachedLookup(cachedPromptLookups, cacheKey, async () => {
    const [prompt] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<PromptDefinition>(`
      SELECT
        p.id AS id,
        p.original_text AS originalText,
        p.prompt_heading AS promptHeading,
        pp.prompt_order AS "order",
        p.type AS type
      FROM app.prompt p
      INNER JOIN app.project_prompt pp ON pp.prompt_id = p.id
      WHERE p.id = '${escapeSqlString(promptId)}'
        AND pp.project_id = '${escapeSqlString(projectId)}'
        AND pp.enabled = TRUE
      LIMIT 1
    `)

    return prompt ?? null
  })
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
      providerUsesFamilyDefault: promptToProcess.providerUsesFamilyDefault,
      workerUrls: promptToProcess.modelWorkerUrls,
    },
    modelContext,
    projectId: promptToProcess.projectId,
    claimIdentity: {
      claimId: promptToProcess.claimId,
      executionSnapshotHash: promptToProcess.executionSnapshotHash,
      executionSnapshotId: promptToProcess.executionSnapshotId,
    },
    contentSettings: {
      useTitle: promptToProcess.useTitle,
      useAbstract: promptToProcess.useAbstract,
      useFulltext: promptToProcess.useFulltext,
      useFulltextNoImages: promptToProcess.useFulltextNoImages,
    },
  })
}

const markAsJudged = async (jobId: string, recordId: string): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  await getJudgmentJobSqliteService().markPromptAsJudged(jobId, recordId)
}

const markAsRetry = async (jobId: string, recordId: string, retryAfterMs: number | null): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  await getJudgmentJobSqliteService().markPromptAsRetry(jobId, recordId, retryAfterMs)
}

const markAsSkipped = async (
  jobId: string,
  recordId: string,
  skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large',
): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  await getJudgmentJobSqliteService().markPromptAsSkipped(jobId, recordId, skipReason)
}

const preparePrompt = async (promptToProcess: PromptToProcess, modelContext: number): Promise<PreparedPromptResult> => {
  const judgmentExists = await checkJudgmentExistsInDatabase(promptToProcess)
  if (judgmentExists) {
    processPromptLogger.log('llm.prompt.skipped.alreadyJudged', '[llm] Skipped - judgment already exists', {
      articleId: promptToProcess.articleId,
      articleIdPrefix: promptToProcess.articleId.slice(0, 8),
      component: processPromptComponent,
      event: 'alreadyJudgedSkip',
      jobId: promptToProcess.jobId,
      promptId: promptToProcess.promptId,
      recordId: promptToProcess.recordId,
    })
    return {kind: 'judged'}
  }

  const needsFulltext = promptToProcess.useFulltext || promptToProcess.useFulltextNoImages
  const article = await getCachedArticle({articleId: promptToProcess.articleId, includeFullText: needsFulltext})

  if (!article) {
    processPromptFailureLogger.error('llm.prompt.articleNotFound', 'Article not found', {
      articleId: promptToProcess.articleId,
      component: processPromptComponent,
      event: 'articleNotFound',
      jobId: promptToProcess.jobId,
      promptId: promptToProcess.promptId,
      recordId: promptToProcess.recordId,
    })
    return {kind: 'judged'}
  }

  let articleWithFulltext = article

  if (needsFulltext) {
    const result = await ensureFullText(articleWithFulltext, article.id)

    if (!result.text) {
      return result.shouldSkip
        ? (() => {
            processPromptLogger.log(`fulltext:skip:${result.reason}`, '[fulltext] Skipping article', {
              articleId: article.id,
              component: processPromptComponent,
              event: 'fulltextSkip',
              jobId: promptToProcess.jobId,
              promptId: promptToProcess.promptId,
              recordId: promptToProcess.recordId,
              skipReason: result.reason,
            })
            return {kind: 'skipped', skipReason: result.reason} as const
          })()
        : (() => {
            processPromptLogger.log(
              'fulltext.transientFailure.requeue',
              '[fulltext] Transient failure, requeuing prompt',
              {
                articleId: article.id,
                component: processPromptComponent,
                event: 'fulltextTransientRequeue',
                jobId: promptToProcess.jobId,
                promptId: promptToProcess.promptId,
                recordId: promptToProcess.recordId,
              },
            )
            return {kind: 'ready'} as const
          })()
    }

    const processResult = processFulltextForLLM(result.text, {
      stripImages: promptToProcess.useFulltextNoImages,
      promptTokenLimit: modelContext,
    })

    if (!processResult.withinBudget) {
      processPromptLogger.log('fulltext:large:chunked-mode', '[fulltext] Large fulltext will rely on chunked judging', {
        articleId: article.id,
        component: processPromptComponent,
        event: 'largeFulltextChunkedMode',
        jobId: promptToProcess.jobId,
        maxTokens: processResult.maxTokens,
        promptId: promptToProcess.promptId,
        recordId: promptToProcess.recordId,
        tokenCount: processResult.tokenCount,
      })
    }

    articleWithFulltext = {...articleWithFulltext, fullText: processResult.processedText}
  }

  const articleForJudging = needsFulltext ? articleWithFulltext : {...articleWithFulltext, fullText: null}
  const prompt = await getCachedPromptDefinition({
    projectId: promptToProcess.projectId,
    promptId: promptToProcess.promptId,
  })

  if (!prompt) {
    processPromptFailureLogger.error('llm.prompt.definitionNotFound', 'Prompt not found or not enabled', {
      articleId: promptToProcess.articleId,
      component: processPromptComponent,
      event: 'promptDefinitionNotFound',
      jobId: promptToProcess.jobId,
      promptId: promptToProcess.promptId,
      projectId: promptToProcess.projectId,
      recordId: promptToProcess.recordId,
    })
    return {kind: 'judged'}
  }

  return {articleForJudging, kind: 'run', prompt}
}

const releasePromptTerminalState = async (
  jobId: string,
  recordId: string,
  terminalState: PromptTerminalState,
): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  return terminalState.kind === 'judged'
    ? markAsJudged(jobId, recordId)
    : terminalState.kind === 'ready'
      ? markAsRetry(jobId, recordId, terminalState.retryAfterMs)
      : markAsSkipped(jobId, recordId, terminalState.skipReason)
}

const enqueueJudgeWorkerTerminalCompletion = async (
  promptToProcess: PromptToProcess,
  terminalState: PromptTerminalState,
): Promise<void> => {
  if (terminalState.kind === 'judged' && (await hasUnackedJudgeWorkerCompletion(promptToProcess.claimId))) {
    return undefined
  }

  await enqueueJudgeWorkerCompletion({
    articleId: promptToProcess.articleId,
    claimId: promptToProcess.claimId,
    executionSnapshotHash: promptToProcess.executionSnapshotHash,
    executionSnapshotId: promptToProcess.executionSnapshotId,
    jobId: promptToProcess.jobId,
    modelId: promptToProcess.modelId,
    projectId: promptToProcess.projectId,
    promptId: promptToProcess.promptId,
    queueRecordId: promptToProcess.recordId,
    retryAfterMs: terminalState.kind === 'ready' ? terminalState.retryAfterMs : undefined,
    skipReason: terminalState.kind === 'skipped' ? terminalState.skipReason : undefined,
    status: terminalState.kind === 'ready' ? 'retry' : terminalState.kind === 'skipped' ? 'skipped' : 'failed',
    useAbstract: promptToProcess.useAbstract,
    useFulltext: promptToProcess.useFulltext,
    useFulltextNoImages: promptToProcess.useFulltextNoImages,
    useTitle: promptToProcess.useTitle,
  })
}

const releaseJudgeWorkerTerminalState = async (
  promptToProcess: PromptToProcess,
  terminalState: PromptTerminalState,
): Promise<void> => {
  await enqueueJudgeWorkerTerminalCompletion(promptToProcess, terminalState)
  await flushJudgeWorkerCompletionOutboxForClaim(promptToProcess.claimId)
}

const getRecoverableRetryDelayMs = (_failureCode: string): number | null => {
  return null
}

export const processPromptWithLLMEffect = (promptToProcess: PromptToProcess): Effect.Effect<void, unknown> => {
  const startTime = Date.now()
  const modelContext = getModelContext(promptToProcess.modelMetadataJson)
  let terminalState: PromptTerminalState = {kind: 'ready', retryAfterMs: null}

  return Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() => {
        return shouldUseJudgeWorkerOwnerHandoff()
          ? Promise.resolve()
          : getJudgmentJobSqliteService().markPromptAsRunning(promptToProcess.jobId, promptToProcess.recordId)
      }),
      () => {
        return Effect.promise(() => {
          return shouldUseJudgeWorkerOwnerHandoff()
            ? releaseJudgeWorkerTerminalState(promptToProcess, terminalState)
            : releasePromptTerminalState(promptToProcess.jobId, promptToProcess.recordId, terminalState)
        })
      },
    ).pipe(
      Effect.flatMap(() => {
        return Effect.promise(async () => {
          const prepared = await withPromptPreparationPermit(() => {
            return preparePrompt(promptToProcess, modelContext)
          })

          if (prepared.kind !== 'run') {
            terminalState = prepared.kind === 'ready' ? {kind: 'ready', retryAfterMs: null} : prepared
            return undefined
          }

          try {
            processPromptLogger.log(`llm:calling:${promptToProcess.modelBaseUrl}`, '[llm] Calling LLM for article', {
              articleId: promptToProcess.articleId,
              articleIdPrefix: promptToProcess.articleId.slice(0, 8),
              component: processPromptComponent,
              event: 'llmCall',
              jobId: promptToProcess.jobId,
              modelBaseUrl: promptToProcess.modelBaseUrl,
              modelId: promptToProcess.modelId,
              promptId: promptToProcess.promptId,
              recordId: promptToProcess.recordId,
            })
            await processSinglePrompt(promptToProcess, prepared.articleForJudging, prepared.prompt, modelContext)
            terminalState = {kind: 'judged'}
            const duration = Date.now() - startTime
            processPromptLogger.log(`llm:success:${promptToProcess.modelBaseUrl}`, '[llm] Success - processed prompt', {
              articleId: promptToProcess.articleId,
              component: processPromptComponent,
              durationMs: duration,
              event: 'llmSuccess',
              jobId: promptToProcess.jobId,
              modelBaseUrl: promptToProcess.modelBaseUrl,
              modelId: promptToProcess.modelId,
              promptId: promptToProcess.promptId,
              recordId: promptToProcess.recordId,
            })
            return undefined
          } catch (error) {
            if (error instanceof ConnectionError) {
              const availability = getJudgmentEndpointAvailability({
                effectiveBaseURL: error.baseURL,
                providerConnectionId: promptToProcess.providerConnectionId,
              })
              const retryMessage = formatConnectionOutageMessage({
                cooldownExpiresAt: availability.cooldownExpiresAt,
                failure: error.failure,
                promptAction:
                  'Prompt requeued because the provider endpoint is unavailable. No further prompts will be sent for this connection until the provider health check passes.',
              })
              processPromptFailureLogger.warn(
                `prompt:retry:${error.failure.kind}:${promptToProcess.modelBaseUrl}`,
                retryMessage,
                {
                  articleId: promptToProcess.articleId,
                  component: processPromptComponent,
                  event: 'connectionRetry',
                  failureKind: error.failure.kind,
                  jobId: promptToProcess.jobId,
                  modelBaseUrl: promptToProcess.modelBaseUrl,
                  promptId: promptToProcess.promptId,
                  recordId: promptToProcess.recordId,
                },
              )
              terminalState = {kind: 'ready', retryAfterMs: null}
              throw error
            }

            if (error instanceof JudgmentPersistenceError) {
              terminalState = {kind: 'ready', retryAfterMs: null}
              throw error
            }

            if (error instanceof RecoverableJudgeError) {
              const consumed = shouldUseJudgeWorkerOwnerHandoff()
                ? true
                : await getJudgmentJobSqliteService().consumePromptExtraRetry({
                    errorCode: error.failureCode,
                    jobId: promptToProcess.jobId,
                    maxExtraRetries: maxRecoverablePromptExtraRetries,
                    recordId: promptToProcess.recordId,
                  })

              if (consumed) {
                terminalState = {kind: 'ready', retryAfterMs: getRecoverableRetryDelayMs(error.failureCode)}
                processPromptFailureLogger.warn(
                  'llm.prompt.recoverableProviderFailureRequeued',
                  '[llm] Requeued prompt after recoverable provider failure',
                  {
                    articleId: promptToProcess.articleId,
                    component: processPromptComponent,
                    diagnostics: error.providerDiagnostics,
                    event: 'recoverableProviderFailureRequeued',
                    failureCode: error.failureCode,
                    jobId: promptToProcess.jobId,
                    promptId: promptToProcess.promptId,
                    recordId: promptToProcess.recordId,
                  },
                )
                throw error
              }

              processPromptFailureLogger.error(
                'llm.prompt.recoverableProviderFailureExhausted',
                '[llm] Recoverable provider failure exhausted extra retries',
                {
                  articleId: promptToProcess.articleId,
                  component: processPromptComponent,
                  diagnostics: error.providerDiagnostics,
                  event: 'recoverableProviderFailureExhausted',
                  failureCode: error.failureCode,
                  jobId: promptToProcess.jobId,
                  promptId: promptToProcess.promptId,
                  recordId: promptToProcess.recordId,
                },
              )
              terminalState = {kind: 'judged'}
              return undefined
            }

            const errorMessage = error instanceof Error ? error.message : String(error)
            processPromptFailureLogger.error('llm.prompt.processFailed', '[llm] ERROR - Failed to process prompt', {
              articleId: promptToProcess.articleId,
              component: processPromptComponent,
              error: errorMessage,
              event: 'processPromptFailed',
              jobId: promptToProcess.jobId,
              promptId: promptToProcess.promptId,
              recordId: promptToProcess.recordId,
            })
            terminalState = {kind: 'judged'}
            return undefined
          }
        })
      }),
    ),
  )
}

export const processPromptWithLLM = async (promptToProcess: PromptToProcess): Promise<void> => {
  await Effect.runPromise(processPromptWithLLMEffect(promptToProcess))
}

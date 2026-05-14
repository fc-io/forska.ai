import {Effect} from 'effect'

import {judgeSinglePrompt, MAX_COMPLETION_TOKENS, RecoverableJudgeError} from '../../../../agent/judge.ts'
import {JudgmentPersistenceError} from '../../../../agent/judge/storeSinglePromptJudgment.ts'
import type {ArticleRecord, PublicationStatus} from '../../../../db/schemaTypes.ts'
import type {StoredProviderInvocationContext} from '../../../providers/providerInvocationService.ts'
import {getProviderModelMetadataPromptTokenLimit} from '../../../providers/providerModelMetadata.ts'
import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {getJudgeWorkerReadOnlyAppQueryService} from '../../../services/getAppReadOnlyQueryService.ts'
import {normalizeProviderKind} from '../../../services/providerCatalog.ts'
import {ensureFullText} from '../../../utils/ensureFullText.ts'
import {processFulltextForLLM} from '../../../utils/fulltextProcessing.ts'
import {createRateLimitedLogger} from '../../../utils/rateLimitedLogger.ts'
import {ConnectionError, formatConnectionOutageMessage} from '../connectionHealth.ts'
import {
  enqueueJudgeWorkerCompletion,
  flushJudgeWorkerCompletionOutboxForClaim,
  getOwnerBackedJudgmentExecutionSnapshot,
  hasUnackedJudgeWorkerCompletion,
  shouldUseJudgeWorkerOwnerHandoff,
} from '../judgeWorkerCompletionJournal.ts'
import {getJudgmentEndpointAvailability} from '../judgmentEndpointAvailability.ts'
import {
  getJudgmentJobSqliteService,
  type PromptCloseoutReason,
  type PromptNoRequestSuccessReason,
} from '../judgmentJobSqliteService.ts'
import {reserveJudgmentPromptRequestWork} from '../judgmentsRequestRuntime.ts'
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
  | {kind: 'closed'; closeoutReason: PromptCloseoutReason}
  | {kind: 'completed'; noRequestSuccessReason: PromptNoRequestSuccessReason}
  | {kind: 'ready'}
  | {kind: 'run'; articleForJudging: ArticleRecord; prompt: PromptDefinition}
  | {kind: 'skipped'; skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large'}

type PromptPreparationWaiter = {limit: number; resolve: (release: () => void) => void}

type PromptTerminalState =
  | {kind: 'closed'; closeoutReason: PromptCloseoutReason}
  | {kind: 'completed'; noRequestSuccessReason?: PromptNoRequestSuccessReason}
  | {kind: 'ready'; retryAfterMs: number | null}
  | {kind: 'skipped'; skipReason: 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large'}

const processPromptLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const processPromptFailureLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const processPromptComponent = 'processPromptWithLLM'
const cachedArticleLookups = new Map<string, Promise<ArticleRecord | null>>()
const cachedOwnerBackedPromptLookups = new Map<string, Promise<{article: ArticleRecord; prompt: PromptDefinition}>>()
const cachedPromptLookups = new Map<string, Promise<PromptDefinition | null>>()

const DEFAULT_MODEL_CONTEXT = 32768
const DEFAULT_PROMPT_TOKEN_LIMIT = Math.max(0, DEFAULT_MODEL_CONTEXT - MAX_COMPLETION_TOKENS)
const maxRecoverablePromptExtraRetries = 1
export const promptPreparationConcurrencyBounds = {maximum: 512, minimum: 2} as const

const promptPreparationWaiters: PromptPreparationWaiter[] = []

let promptPreparationInFlight = 0

export const getPromptPreparationConcurrencyLimit = ({
  providerMaxInflightRequests,
}: {
  providerMaxInflightRequests: number | null | undefined
}): number => {
  const providerLimit =
    typeof providerMaxInflightRequests === 'number' && Number.isFinite(providerMaxInflightRequests)
      ? Math.max(1, Math.trunc(providerMaxInflightRequests))
      : 1
  const dynamicLimit = Math.max(promptPreparationConcurrencyBounds.minimum, providerLimit * 2)

  return Math.min(promptPreparationConcurrencyBounds.maximum, dynamicLimit)
}

const getModelContext = (metadataJson: unknown): number => {
  return getProviderModelMetadataPromptTokenLimit(metadataJson, MAX_COMPLETION_TOKENS) ?? DEFAULT_PROMPT_TOKEN_LIMIT
}

const getOwnerBackedProviderInvocationContext = (promptToProcess: PromptToProcess): StoredProviderInvocationContext => {
  const providerKind = normalizeProviderKind(promptToProcess.modelProvider)
  const providerConnectionId =
    promptToProcess.providerId
    ?? promptToProcess.providerConnectionId
    ?? promptToProcess.providerKey
    ?? promptToProcess.modelId

  return {
    connection: {
      authMode: null,
      baseURL: promptToProcess.modelBaseUrl,
      config: {manualWorkerUrls: promptToProcess.modelWorkerUrls, workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: Boolean(promptToProcess.modelSecretRef),
      id: providerConnectionId,
      label: promptToProcess.providerName ?? providerConnectionId,
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: promptToProcess.maxInflightRequests ?? null,
      providerKind,
      secretRef: promptToProcess.modelSecretRef,
      updatedAt: null,
    },
    model: {
      baseURL: promptToProcess.modelBaseUrl,
      createdAt: null,
      displayName: promptToProcess.modelName,
      enabled: true,
      id: promptToProcess.modelId,
      metadataJson: promptToProcess.modelMetadataJson,
      modelName: promptToProcess.modelName,
      name: promptToProcess.modelName,
      provider: providerKind,
      providerConnectionId,
      remoteModelId: promptToProcess.modelName,
      source: null,
      updatedAt: null,
      variant: promptToProcess.modelVersion,
      version: promptToProcess.modelVersion,
    },
  }
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

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringValue = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null
}

const getNumberValue = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getDateOrNull = (value: unknown): Date | null => {
  const isoValue = getStringValue(value)

  return isoValue ? new Date(isoValue) : null
}

const getPublicationStatus = (value: unknown): PublicationStatus | null => {
  return value === 'accepted'
    || value === 'preprint'
    || value === 'published'
    || value === 'retracted'
    || value === 'submitted'
    ? value
    : null
}

const getOwnerBackedPromptInput = async (
  promptToProcess: PromptToProcess,
): Promise<{article: ArticleRecord; prompt: PromptDefinition}> => {
  const cacheKey = `${promptToProcess.executionSnapshotId}:${promptToProcess.executionSnapshotHash}`
  const buildPromptInput = (payloadValue: unknown): {article: ArticleRecord; prompt: PromptDefinition} => {
    const payload = isObjectRecord(payloadValue) ? payloadValue : null
    const articlePayload = payload && isObjectRecord(payload.article) ? payload.article : null
    const promptPayload = payload && isObjectRecord(payload.prompt) ? payload.prompt : null
    const articleId = getStringValue(articlePayload?.id) ?? promptToProcess.articleId
    const promptId = getStringValue(promptPayload?.id) ?? promptToProcess.promptId
    const promptOriginalText = getStringValue(promptPayload?.originalText)

    if (!articlePayload || !promptPayload || promptOriginalText === null) {
      throw new Error(
        `owner-backed execution snapshot is missing required prompt data for claim ${promptToProcess.claimId}`,
      )
    }

    return {
      article: {
        id: articleId,
        createdAt: getDateOrNull(articlePayload.articleCreatedAt) ?? new Date(0),
        updatedAt: getDateOrNull(articlePayload.articleUpdatedAt) ?? new Date(0),
        articleTitle: getStringValue(articlePayload.articleTitle) ?? '',
        articleAuthors: null,
        articleCreatedAt: getDateOrNull(articlePayload.articleCreatedAt),
        articleUpdatedAt: getDateOrNull(articlePayload.articleUpdatedAt),
        articleId: getStringValue(articlePayload.articleId),
        articleSummary: getStringValue(articlePayload.articleSummary),
        articleVersion: getNumberValue(articlePayload.articleVersion),
        arxivId: null,
        biorxivId: null,
        medrxivId: null,
        doi: getStringValue(articlePayload.doi),
        pubmedId: null,
        url: getStringValue(articlePayload.url),
        fullTextFetchedAt: getDateOrNull(articlePayload.fullTextFetchedAt),
        fullText: getStringValue(articlePayload.fullText),
        fullTextHtml: getStringValue(articlePayload.fullTextHtml),
        fullTextSource: getStringValue(articlePayload.fullTextSource),
        fullTextOriginalFormat: getStringValue(articlePayload.fullTextOriginalFormat),
        fullTextPDF: getStringValue(articlePayload.fullTextPdf),
        fullTextAssets: articlePayload.fullTextAssets ?? null,
        fullTextConversionStatus: getStringValue(articlePayload.fullTextConversionStatus),
        fullTextConversionError: getStringValue(articlePayload.fullTextConversionError),
        fullTextConversionAttempts: getNumberValue(articlePayload.fullTextConversionAttempts),
        fullTextConversionModelId: getStringValue(articlePayload.fullTextConversionModelId),
        fullTextConversionMetadata: articlePayload.fullTextConversionMetadata ?? null,
        fullTextCharCount: getNumberValue(articlePayload.fullTextCharCount),
        contentHash: getStringValue(articlePayload.contentHash),
        importRoute: getStringValue(articlePayload.importRoute),
        originalData: articlePayload.originalData ?? null,
        sourceMetadata: articlePayload.sourceMetadata ?? null,
        publicationStatus: getPublicationStatus(articlePayload.publicationStatus),
      },
      prompt: {
        id: promptId,
        originalText: promptOriginalText,
        promptHeading: getStringValue(promptPayload.promptHeading),
        order: getNumberValue(promptPayload.order),
        type: getStringValue(promptPayload.type),
      },
    }
  }

  if (promptToProcess.executionSnapshotPayload !== undefined) {
    return buildPromptInput(promptToProcess.executionSnapshotPayload)
  }

  return withCachedLookup(cachedOwnerBackedPromptLookups, cacheKey, async () => {
    const snapshot = await getOwnerBackedJudgmentExecutionSnapshot({
      executionSnapshotHash: promptToProcess.executionSnapshotHash,
      executionSnapshotId: promptToProcess.executionSnapshotId,
    })

    return buildPromptInput(snapshot.payload)
  })
}

const getCachedArticle = async ({
  articleId,
  includeFullText,
  projectId,
}: {
  articleId: string
  includeFullText: boolean
  projectId: string
}): Promise<ArticleRecord | null> => {
  const cacheKey = `${projectId}:${articleId}:${includeFullText ? 'fulltext' : 'metadata'}`

  return withCachedLookup(cachedArticleLookups, cacheKey, async () => {
    const [article] = await getJudgeWorkerReadOnlyAppQueryService().getFullArticlesByIds([articleId], {
      includeFullText,
      projectId,
    })

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

const drainPromptPreparationWaiters = (): void => {
  const waiterIndex = promptPreparationWaiters.findIndex((waiter) => {
    return promptPreparationInFlight < waiter.limit
  })
  const nextWaiter = waiterIndex >= 0 ? promptPreparationWaiters.splice(waiterIndex, 1)[0] : null

  if (nextWaiter) {
    promptPreparationInFlight += 1
    nextWaiter.resolve(() => {
      releasePromptPreparationSlot()
    })
    drainPromptPreparationWaiters()
  }
}

const releasePromptPreparationSlot = (): void => {
  promptPreparationInFlight = Math.max(0, promptPreparationInFlight - 1)
  drainPromptPreparationWaiters()
}

const acquirePromptPreparationSlot = async (limit: number): Promise<() => void> => {
  if (promptPreparationInFlight < limit) {
    promptPreparationInFlight += 1
    return () => {
      releasePromptPreparationSlot()
    }
  }

  return new Promise((resolve) => {
    promptPreparationWaiters.push({limit, resolve})
  })
}

const withPromptPreparationPermit = async <T>(promptToProcess: PromptToProcess, work: () => Promise<T>): Promise<T> => {
  const release = await acquirePromptPreparationSlot(
    getPromptPreparationConcurrencyLimit({providerMaxInflightRequests: promptToProcess.providerMaxInflightRequests}),
  )

  try {
    return await work()
  } finally {
    release()
  }
}

export const getPromptPreparationConcurrencyStatsForTests = (): {inFlight: number; waiting: number} => {
  return {inFlight: promptPreparationInFlight, waiting: promptPreparationWaiters.length}
}

export const resetPromptPreparationConcurrencyForTests = (): void => {
  promptPreparationWaiters.splice(0, promptPreparationWaiters.length)
  promptPreparationInFlight = 0
}

const processSinglePrompt = async (
  promptToProcess: PromptToProcess,
  article: ArticleRecord,
  prompt: PromptDefinition,
  modelContext: number,
): Promise<void> => {
  const sessionId = null
  const releaseRequestWork = reserveJudgmentPromptRequestWork({
    judgmentsJobId: promptToProcess.jobId,
    queueRecordId: promptToProcess.recordId,
    requestWorkUnits: 1,
  })

  try {
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
        providerInvocationContext: shouldUseJudgeWorkerOwnerHandoff()
          ? getOwnerBackedProviderInvocationContext(promptToProcess)
          : undefined,
        providerFamily: promptToProcess.providerFamily,
        providerId: promptToProcess.providerId,
        providerKey: promptToProcess.providerKey,
        providerLimit: promptToProcess.providerLimit,
        providerLimitVersion: promptToProcess.providerLimitVersion,
        providerMaxInflightRequests: promptToProcess.providerMaxInflightRequests,
        providerName: promptToProcess.providerName,
        providerUsesFamilyDefault: promptToProcess.providerUsesFamilyDefault,
        resolvedDefaultCapacity: promptToProcess.resolvedDefaultCapacity,
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
  } finally {
    releaseRequestWork()
  }
}

const markAsJudged = async (jobId: string, recordId: string): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  await getJudgmentJobSqliteService().markPromptAsJudged(jobId, recordId)
}

const markAsNoRequestSuccess = async (
  jobId: string,
  recordId: string,
  reason: PromptNoRequestSuccessReason,
): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  await getJudgmentJobSqliteService().markPromptAsNoRequestSuccess(jobId, recordId, reason)
}

const markAsClosed = async (jobId: string, recordId: string, reason: PromptCloseoutReason): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  await getJudgmentJobSqliteService().markPromptAsClosed(jobId, recordId, reason)
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

const prepareLocalPrompt = async (
  promptToProcess: PromptToProcess,
  modelContext: number,
): Promise<PreparedPromptResult> => {
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
    return {kind: 'completed', noRequestSuccessReason: 'alreadyJudged'}
  }

  const needsFulltext = promptToProcess.useFulltext || promptToProcess.useFulltextNoImages
  const article = await getCachedArticle({
    articleId: promptToProcess.articleId,
    includeFullText: needsFulltext,
    projectId: promptToProcess.projectId,
  })

  if (!article) {
    processPromptFailureLogger.error('llm.prompt.articleNotFound', 'Article not found', {
      articleId: promptToProcess.articleId,
      component: processPromptComponent,
      event: 'articleNotFound',
      jobId: promptToProcess.jobId,
      promptId: promptToProcess.promptId,
      recordId: promptToProcess.recordId,
    })
    return {closeoutReason: 'articleMissing', kind: 'closed'}
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
    return {closeoutReason: 'promptMissing', kind: 'closed'}
  }

  return {articleForJudging, kind: 'run', prompt}
}

const prepareOwnerBackedPrompt = async (
  promptToProcess: PromptToProcess,
  modelContext: number,
): Promise<PreparedPromptResult> => {
  const needsFulltext = promptToProcess.useFulltext || promptToProcess.useFulltextNoImages
  const ownerBackedInput = await getOwnerBackedPromptInput(promptToProcess)
  let articleWithFulltext = ownerBackedInput.article

  if (needsFulltext) {
    if (!articleWithFulltext.fullText) {
      if (articleWithFulltext.fullTextConversionStatus === 'failed' || !articleWithFulltext.fullTextPDF) {
        const skipReason =
          articleWithFulltext.fullTextConversionStatus === 'failed' ? 'conversion_failed' : 'no_fulltext'

        processPromptLogger.log(`fulltext:skip:${skipReason}`, '[fulltext] Skipping article', {
          articleId: articleWithFulltext.id,
          component: processPromptComponent,
          event: 'fulltextSkip',
          jobId: promptToProcess.jobId,
          promptId: promptToProcess.promptId,
          recordId: promptToProcess.recordId,
          skipReason,
        })

        return {kind: 'skipped', skipReason}
      }

      processPromptLogger.log(
        'fulltext.transientFailure.requeue',
        '[fulltext] Snapshot missing fulltext, requeuing prompt',
        {
          articleId: articleWithFulltext.id,
          component: processPromptComponent,
          event: 'fulltextTransientRequeue',
          jobId: promptToProcess.jobId,
          promptId: promptToProcess.promptId,
          recordId: promptToProcess.recordId,
        },
      )

      return {kind: 'ready'}
    }

    const processResult = processFulltextForLLM(articleWithFulltext.fullText, {
      stripImages: promptToProcess.useFulltextNoImages,
      promptTokenLimit: modelContext,
    })

    if (!processResult.withinBudget) {
      processPromptLogger.log('fulltext:large:chunked-mode', '[fulltext] Large fulltext will rely on chunked judging', {
        articleId: articleWithFulltext.id,
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

  return {
    articleForJudging: needsFulltext ? articleWithFulltext : {...articleWithFulltext, fullText: null},
    kind: 'run',
    prompt: ownerBackedInput.prompt,
  }
}

const preparePrompt = async (promptToProcess: PromptToProcess, modelContext: number): Promise<PreparedPromptResult> => {
  return shouldUseJudgeWorkerOwnerHandoff()
    ? prepareOwnerBackedPrompt(promptToProcess, modelContext)
    : prepareLocalPrompt(promptToProcess, modelContext)
}

const releasePromptTerminalState = async (
  jobId: string,
  recordId: string,
  terminalState: PromptTerminalState,
): Promise<void> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return undefined
  }

  return terminalState.kind === 'completed' && terminalState.noRequestSuccessReason
    ? markAsNoRequestSuccess(jobId, recordId, terminalState.noRequestSuccessReason)
    : terminalState.kind === 'completed'
      ? markAsJudged(jobId, recordId)
      : terminalState.kind === 'closed'
        ? markAsClosed(jobId, recordId, terminalState.closeoutReason)
        : terminalState.kind === 'ready'
          ? markAsRetry(jobId, recordId, terminalState.retryAfterMs)
          : markAsSkipped(jobId, recordId, terminalState.skipReason)
}

const enqueueJudgeWorkerTerminalCompletion = async (
  promptToProcess: PromptToProcess,
  terminalState: PromptTerminalState,
): Promise<void> => {
  if (terminalState.kind === 'completed' && (await hasUnackedJudgeWorkerCompletion(promptToProcess.claimId))) {
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
  void flushJudgeWorkerCompletionOutboxForClaim(promptToProcess.claimId).catch((error) => {
    processPromptFailureLogger.warn(
      `llm.ownerCompletionFlush.failed.${promptToProcess.claimId}`,
      '[llm] owner completion flush failed after durable enqueue',
      {
        articleId: promptToProcess.articleId,
        claimId: promptToProcess.claimId,
        component: processPromptComponent,
        error: error instanceof Error ? error.message : String(error),
        event: 'ownerCompletionFlushFailed',
        jobId: promptToProcess.jobId,
        promptId: promptToProcess.promptId,
        recordId: promptToProcess.recordId,
      },
    )
  })
}

const getRecoverableRetryDelayMs = (_failureCode: string): number | null => {
  return null
}

const getPromptPreparationCloseoutReason = (error: unknown): PromptCloseoutReason => {
  const message = error instanceof Error ? error.message : String(error)

  return message.includes('missing required prompt data') ? 'promptMissing' : 'requestFailure'
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
          const prepared = await withPromptPreparationPermit(promptToProcess, () => {
            return preparePrompt(promptToProcess, modelContext)
          }).catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error)
            const closeoutReason = getPromptPreparationCloseoutReason(error)
            processPromptFailureLogger.error('llm.prompt.preparationFailed', '[llm] ERROR - Failed to prepare prompt', {
              articleId: promptToProcess.articleId,
              component: processPromptComponent,
              error: errorMessage,
              event: 'promptPreparationFailed',
              jobId: promptToProcess.jobId,
              promptId: promptToProcess.promptId,
              recordId: promptToProcess.recordId,
            })
            terminalState = {closeoutReason, kind: 'closed'}
            return null
          })

          if (!prepared) {
            return undefined
          }

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
            terminalState = {kind: 'completed'}
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
                modelId: promptToProcess.modelId,
                modelProvider: promptToProcess.modelProvider,
                providerConnectionId: promptToProcess.providerConnectionId,
                useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
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
              terminalState = {closeoutReason: 'recoverableRequestFailureExhausted', kind: 'closed'}
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
            terminalState = {closeoutReason: 'requestFailure', kind: 'closed'}
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

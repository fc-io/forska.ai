import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {storeConvertedFullText} from '../fullText/canonicalFullTextStore.ts'
import {getConverterServerFailure} from '../fullText/converters/conversionError.ts'
import {
  clearConverterServerFailure,
  recordConverterServerFailure,
} from '../fullText/converters/converterServerHealth.ts'
import {
  convertArticlePdf,
  type FullTextConversionRuntimeConfig,
  getFullTextConversionFailureMetadata,
  isPermanentConversionFailure,
} from '../fullText/converters/fullTextConverter.ts'
import {getJsonSqlLiteral} from '../providers/providerDbUtils.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {env} from '../utils/env.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {
  type FullTextCronProject,
  getFullTextCronGate,
  logFullTextCronGateBlocked,
  selectFullTextCronArticles,
} from './fullTextJobs/fullTextCronScope.ts'

const CONVERSION_INTERVAL = '0 */2 * * * *' // Every 2 minutes
const CONVERSION_TIMEOUT_MS = 600_000 // 10 minutes
const MAX_CONVERSION_ATTEMPTS = 3
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_CONCURRENCY = 2
// Maximum number of concurrent batch runs allowed
const MAX_CONCURRENT_BATCHES = 3
const fullTextConversionLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const fullTextConversionWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const fullTextConversionComponent = 'fullTextConversionJobs'
const fullTextConversionWorkloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'fullText.conversion.cron',
  workloadClass: 'background.fullText.conversion',
}

const normalizePositiveInt = (value: number | null | undefined, fallback: number): number => {
  const raw = value == null ? fallback : value
  const normalized = Math.trunc(raw)
  return normalized > 0 ? normalized : fallback
}

const getConversionBatchSize = (): number => {
  return normalizePositiveInt(env.FULL_TEXT_CONVERSION_BATCH_SIZE, DEFAULT_BATCH_SIZE)
}

const getConversionConcurrency = (batchSize: number): number => {
  const normalized = normalizePositiveInt(env.FULL_TEXT_CONVERSION_CONCURRENCY, DEFAULT_CONCURRENCY)
  return Math.min(batchSize, normalized)
}

type ArticleForConversion = {id: string; fullTextPDF: string; fullTextConversionAttempts: number | null}

export const fullTextConversionArticleConditions = [
  `a.full_text_pdf IS NOT NULL`,
  `a.full_text IS NULL`,
  `(a.full_text_conversion_status IS NULL OR a.full_text_conversion_status != 'failed')`,
  `(a.full_text_conversion_attempts IS NULL OR a.full_text_conversion_attempts < ${MAX_CONVERSION_ATTEMPTS})`,
]

export const getArticlesNeedingConversion = async ({
  batchSize,
  projects,
}: {
  batchSize: number
  projects: FullTextCronProject[]
}): Promise<ArticleForConversion[]> => {
  const startedAt = Date.now()
  const articles = await selectFullTextCronArticles<ArticleForConversion>({
    articleConditions: fullTextConversionArticleConditions,
    limit: batchSize,
    onProjectScanned: ({durationMs, project, resultCount}) => {
      fullTextConversionLogger.log(
        'fullTextConversion:projectScanned',
        '[fullTextConversion] Project conversion scan',
        {
          component: fullTextConversionComponent,
          durationMs,
          hasRunningJob: project.hasRunningJob,
          projectId: project.projectId,
          resultCount,
        },
      )
    },
    projects,
    selectColumns:
      'a.id AS id, a.full_text_pdf AS fullTextPDF, a.full_text_conversion_attempts AS fullTextConversionAttempts',
    workloadContext: fullTextConversionWorkloadContext,
  })

  fullTextConversionLogger.log(
    'fullTextConversion:articlesSelected',
    '[fullTextConversion] Articles selected for conversion',
    {
      batchSize,
      component: fullTextConversionComponent,
      durationMs: Date.now() - startedAt,
      projectCount: projects.length,
      resultCount: articles.length,
    },
  )

  return articles
}

type ConversionBatch = {queue: ArticleForConversion[]; stoppedBy: {articleId: string; errorMessage: string} | null}

type ConvertArticleOutcome = {serverFailure: string | null}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const getBatchStop = (articleId: string, outcome: ConvertArticleOutcome): ConversionBatch['stoppedBy'] => {
  return outcome.serverFailure === null ? null : {articleId, errorMessage: outcome.serverFailure}
}

const runConversionWorker = async ({
  batch,
  runtimeConfig,
}: {
  batch: ConversionBatch
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<void> => {
  const article = batch.stoppedBy ? undefined : batch.queue.pop()
  if (!article) return
  const outcome = await convertArticle({article, runtimeConfig})
  batch.stoppedBy = batch.stoppedBy ?? getBatchStop(article.id, outcome)
  return runConversionWorker({batch, runtimeConfig})
}

const logStoppedBatch = ({
  runtimeConfig,
  stoppedBy,
  untouchedArticleCount,
}: {
  runtimeConfig: FullTextConversionRuntimeConfig
  stoppedBy: NonNullable<ConversionBatch['stoppedBy']>
  untouchedArticleCount: number
}): void => {
  fullTextConversionWarningLogger.warn(
    'fullTextConversion:batchStopped',
    '[fullTextConversion] Converter server unavailable; batch stopped until the next wake',
    {
      articleId: stoppedBy.articleId,
      component: fullTextConversionComponent,
      errorMessage: stoppedBy.errorMessage,
      modelName: runtimeConfig.modelName,
      untouchedArticleCount,
    },
  )
}

export const convertArticles = async ({
  articles,
  concurrency,
  runtimeConfig,
}: {
  articles: ArticleForConversion[]
  concurrency: number
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<void> => {
  const workerCount = Math.min(concurrency, articles.length)
  const batch: ConversionBatch = {queue: articles.slice(), stoppedBy: null}

  const results = await Promise.allSettled(
    Array.from({length: workerCount}, () => {
      return runConversionWorker({batch, runtimeConfig})
    }),
  )

  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  })

  if (rejected.length > 0) {
    fullTextConversionWarningLogger.error('fullTextConversion:workerFailures', '[fullTextConversion] Worker failures', {
      component: fullTextConversionComponent,
      rejected: rejected.length,
      total: results.length,
    })
  }

  if (batch.stoppedBy) {
    logStoppedBatch({runtimeConfig, stoppedBy: batch.stoppedBy, untouchedArticleCount: batch.queue.length})
  }
}

const recordFailedConversionAttempt = async ({
  article,
  error,
  runtimeConfig,
  startTime,
}: {
  article: ArticleForConversion
  error: unknown
  runtimeConfig: FullTextConversionRuntimeConfig
  startTime: number
}): Promise<void> => {
  const errorMessage = getErrorMessage(error)
  const isPerm = isPermanentConversionFailure(error)
  const attempts = (article.fullTextConversionAttempts ?? 0) + 1
  const isFinalFailure = isPerm || attempts >= MAX_CONVERSION_ATTEMPTS

  await getAppDatabaseService().runBackground(
    `
    UPDATE app.article
    SET full_text_conversion_status = ${isFinalFailure ? `'failed'` : 'NULL'},
        full_text_conversion_error = ${getSqlLiteral(errorMessage)},
        full_text_conversion_model_id = ${getSqlLiteral(runtimeConfig.modelId)},
        full_text_conversion_metadata = ${getJsonSqlLiteral(getFullTextConversionFailureMetadata(runtimeConfig))},
        full_text_conversion_attempts = ${attempts},
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(article.id)}'
  `,
    fullTextConversionWorkloadContext,
  )

  fullTextConversionWarningLogger.warn(
    `fullTextConversion:articleConversion:${isFinalFailure ? 'failed' : 'retry'}`,
    `[fullTextConversion] Article conversion ${isFinalFailure ? 'failed' : 'will retry'}`,
    {
      articleId: article.id,
      attempts,
      component: fullTextConversionComponent,
      durationMs: Date.now() - startTime,
      errorMessage,
      finalFailure: isFinalFailure,
      modelName: runtimeConfig.modelName,
    },
  )
}

const handleConversionFailure = async ({
  article,
  error,
  runtimeConfig,
  startTime,
}: {
  article: ArticleForConversion
  error: unknown
  runtimeConfig: FullTextConversionRuntimeConfig
  startTime: number
}): Promise<ConvertArticleOutcome> => {
  const serverFailure = getConverterServerFailure(error)

  if (serverFailure !== null) {
    await recordConverterServerFailure({articleId: article.id, error, runtimeConfig})
  }

  if (serverFailure !== 'refused') {
    await recordFailedConversionAttempt({article, error, runtimeConfig, startTime})
  }

  return {serverFailure: serverFailure === null ? null : getErrorMessage(error)}
}

export const convertArticle = async ({
  article,
  runtimeConfig,
}: {
  article: ArticleForConversion
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<ConvertArticleOutcome> => {
  const startTime = Date.now()
  fullTextConversionLogger.log(
    'fullTextConversion:articleConversionStarted',
    '[fullTextConversion] Article conversion started',
    {articleId: article.id, component: fullTextConversionComponent, modelName: runtimeConfig.modelName},
  )

  try {
    const result = await convertArticlePdf({
      articleId: article.id,
      pdfPath: article.fullTextPDF,
      runtimeConfig,
      timeoutMs: CONVERSION_TIMEOUT_MS,
    })
    const canonical = await storeConvertedFullText({
      articleId: article.id,
      attempts: (article.fullTextConversionAttempts ?? 0) + 1,
      mutationSource: 'fullTextConversionJobs',
      result,
      runtimeConfig,
      workloadContext: fullTextConversionWorkloadContext,
    })

    await clearConverterServerFailure(runtimeConfig)

    fullTextConversionLogger.log(
      'fullTextConversion:articleConversionSucceeded',
      '[fullTextConversion] Article conversion succeeded',
      {
        articleId: article.id,
        canonicalHash: canonical.hash,
        charCount: canonical.text.length,
        component: fullTextConversionComponent,
        converterKind: result.converterKind,
        converterVersion: result.converterVersion,
        durationMs: Date.now() - startTime,
        figureCount: result.figures.length,
        modelName: runtimeConfig.modelName,
      },
    )

    return {serverFailure: null}
  } catch (error) {
    return handleConversionFailure({article, error, runtimeConfig, startTime})
  }
}

// Counter to track how many batches are currently running
let runningBatches = 0

const runConversionBatch = async () => {
  if (!shouldCurrentServerRunMaintenanceLoops()) return

  if (runningBatches >= MAX_CONCURRENT_BATCHES) {
    fullTextConversionLogger.log(
      'fullTextConversion:maxConcurrentBatchesReached',
      '[fullTextConversion] Max concurrent batches reached',
      {component: fullTextConversionComponent, maxConcurrentBatches: MAX_CONCURRENT_BATCHES, runningBatches},
    )
    return
  }

  runningBatches++
  const batchNumber = runningBatches
  try {
    const batchSize = getConversionBatchSize()
    const concurrency = getConversionConcurrency(batchSize)
    const gate = await getFullTextCronGate({
      enabled: env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON,
      workloadContext: fullTextConversionWorkloadContext,
    })

    if (!shouldCurrentServerRunMaintenanceLoops()) return

    if (!gate.open) {
      logFullTextCronGateBlocked({component: fullTextConversionComponent, reason: gate.reason})
      return
    }

    const {projects, runtimeConfig} = gate

    fullTextConversionLogger.log('fullTextConversion:batchStarted', '[fullTextConversion] Conversion batch started', {
      batchNumber,
      batchSize,
      component: fullTextConversionComponent,
      concurrency,
      maxConcurrentBatches: MAX_CONCURRENT_BATCHES,
      modelName: runtimeConfig.modelName,
      runningBatches,
    })

    const articles = await getArticlesNeedingConversion({batchSize, projects})

    if (articles.length === 0) {
      fullTextConversionLogger.log('fullTextConversion:batchEmpty', '[fullTextConversion] Conversion batch empty', {
        batchNumber,
        component: fullTextConversionComponent,
      })
      return
    }

    await convertArticles({articles, concurrency, runtimeConfig})
  } catch (error) {
    if (!isExpectedDuckdbOwnerRoleLossError(error)) {
      throw error
    }
  } finally {
    runningBatches--
  }
}

export const fullTextConversionJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-convert-pdfs', pattern: CONVERSION_INTERVAL, run: runConversionBatch}),
)

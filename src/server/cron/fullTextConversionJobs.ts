import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {getJsonSqlLiteral} from '../providers/providerDbUtils.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {ConversionError, convertPdfToText} from '../utils/convertPdfToText.ts'
import {env} from '../utils/env.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'

const CONVERSION_INTERVAL = '0 */2 * * * *' // Every 2 minutes
const DOCLING_CONVERSION_TIMEOUT_MS = 600_000 // 10 minutes
const MAX_CONVERSION_ATTEMPTS = 3
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_CONCURRENCY = 1
const MAX_RUNNING_JOB_PROJECTS_PER_SCAN = 100
const MAX_PROJECT_IMPORT_ROUTES_PER_SCAN = 100
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
type FullTextConversionRuntimeConfig = {baseURL: string; modelId: string; modelName: string; providerKind: string}

/**
 * Get articles with PDFs that need conversion, prioritizing:
 * 1. Articles from projects with running jobs + useFulltext=true
 * 2. Articles from projects with running jobs + useFulltext=false
 * 3. Fallback: any articles by created_at DESC
 */
const getArticlesNeedingConversion = async (batchSize: number): Promise<ArticleForConversion[]> => {
  const collectedArticles: ArticleForConversion[] = []
  const seenIds = new Set<string>()
  const startedAt = Date.now()

  // Base conditions: has PDF, no fullText, not failed, not exceeded retry limit
  const baseConditions = [
    `a.full_text_pdf IS NOT NULL`,
    `(a.full_text IS NULL OR a.full_text_html IS NULL)`,
    `(a.full_text_conversion_status IS NULL OR a.full_text_conversion_status != 'failed')`,
    `(a.full_text_conversion_attempts IS NULL OR a.full_text_conversion_attempts < ${MAX_CONVERSION_ATTEMPTS})`,
  ]

  // Step 1: Get running jobs with their projects
  const runningJobsQueryStartedAt = Date.now()
  const runningJobsWithProjects = await getAppDatabaseService().queryJsonBackground<{
    jobId: string
    projectId: string
    useFulltext: boolean
    dateFrom: unknown
    dateTo: unknown
  }>(
    `
    SELECT
      jj.id AS jobId,
      p.id AS projectId,
      p.use_fulltext AS useFulltext,
      p.date_from AS dateFrom,
      p.date_to AS dateTo
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    WHERE jj.status = 'running'
    ORDER BY p.use_fulltext DESC
    LIMIT ${MAX_RUNNING_JOB_PROJECTS_PER_SCAN}
  `,
    {...fullTextConversionWorkloadContext, maxResultRows: MAX_RUNNING_JOB_PROJECTS_PER_SCAN},
  )

  fullTextConversionLogger.log('fullTextConversion:runningJobsQueried', '[fullTextConversion] Running jobs queried', {
    component: fullTextConversionComponent,
    durationMs: Date.now() - runningJobsQueryStartedAt,
    runningJobCount: runningJobsWithProjects.length,
  })

  // Step 2: For each project, find articles needing conversion
  for (const {projectId, useFulltext, dateFrom, dateTo} of runningJobsWithProjects) {
    if (collectedArticles.length >= batchSize) break

    const remaining = batchSize - collectedArticles.length
    fullTextConversionLogger.log(
      'fullTextConversion:projectScanStarted',
      '[fullTextConversion] Project conversion scan started',
      {
        collectedArticleCount: collectedArticles.length,
        component: fullTextConversionComponent,
        projectId,
        remaining,
        useFulltext,
      },
    )

    // Build date conditions
    const dateConditions = [
      dateFrom ? `a.article_created_at >= ${getTimestampLiteral(getDateValue(dateFrom) ?? new Date(0))}` : null,
      dateTo ? `a.article_created_at <= ${getTimestampLiteral(getDateValue(dateTo) ?? new Date(0))}` : null,
    ].filter((part): part is string => {
      return part !== null
    })

    // Try importRoute path first
    const projectRoutesQueryStartedAt = Date.now()
    const projectRoutes = await getAppDatabaseService().queryJsonBackground<{importRouteId: string}>(
      `
      SELECT import_route_id AS importRouteId
      FROM app.project_import_route
      WHERE project_id = '${escapeSqlString(projectId)}'
      ORDER BY import_route_id ASC
      LIMIT ${MAX_PROJECT_IMPORT_ROUTES_PER_SCAN}
    `,
      {...fullTextConversionWorkloadContext, maxResultRows: MAX_PROJECT_IMPORT_ROUTES_PER_SCAN, projectId},
    )
    fullTextConversionLogger.log(
      'fullTextConversion:projectRoutesQueried',
      '[fullTextConversion] Project import routes queried',
      {
        component: fullTextConversionComponent,
        durationMs: Date.now() - projectRoutesQueryStartedAt,
        projectId,
        routeCount: projectRoutes.length,
      },
    )

    if (projectRoutes.length > 0) {
      const routeIds = projectRoutes.map((r) => {
        return r.importRouteId
      })
      const articlesViaRouteQueryStartedAt = Date.now()
      const articlesViaRoute = await getAppDatabaseService().queryJsonBackground<ArticleForConversion>(
        `
        SELECT
          a.id AS id,
          a.full_text_pdf AS fullTextPDF,
          a.full_text_conversion_attempts AS fullTextConversionAttempts
        FROM app.article a
        INNER JOIN app.article_import_route air ON air.article_id = a.id
        WHERE air.import_route_id IN (${getQuotedStringList(routeIds).join(', ')})
          AND ${[...baseConditions, ...dateConditions].join(' AND ')}
        ORDER BY a.article_created_at DESC NULLS LAST
        LIMIT ${remaining}
      `,
        {...fullTextConversionWorkloadContext, maxResultRows: remaining, projectId},
      )
      fullTextConversionLogger.log(
        'fullTextConversion:articlesViaImportRouteQueried',
        '[fullTextConversion] Articles via import route queried',
        {
          component: fullTextConversionComponent,
          durationMs: Date.now() - articlesViaRouteQueryStartedAt,
          projectId,
          resultCount: articlesViaRoute.length,
          routeCount: routeIds.length,
        },
      )

      for (const article of articlesViaRoute) {
        if (!seenIds.has(article.id) && article.fullTextPDF) {
          seenIds.add(article.id)
          collectedArticles.push(article)
        }
      }
      continue
    }

    // Try project_articles path
    const articlesViaProjectQueryStartedAt = Date.now()
    const articlesViaDirect = await getAppDatabaseService().queryJsonBackground<ArticleForConversion>(
      `
      SELECT
        a.id AS id,
        a.full_text_pdf AS fullTextPDF,
        a.full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article a
      INNER JOIN app.project_article pa ON pa.article_id = a.id
      WHERE pa.project_id = '${escapeSqlString(projectId)}'
        AND ${[...baseConditions, ...dateConditions].join(' AND ')}
      ORDER BY a.article_created_at DESC NULLS LAST
      LIMIT ${remaining}
    `,
      {...fullTextConversionWorkloadContext, maxResultRows: remaining, projectId},
    )
    fullTextConversionLogger.log(
      'fullTextConversion:articlesViaProjectQueried',
      '[fullTextConversion] Articles via project queried',
      {
        component: fullTextConversionComponent,
        durationMs: Date.now() - articlesViaProjectQueryStartedAt,
        projectId,
        resultCount: articlesViaDirect.length,
      },
    )

    for (const article of articlesViaDirect) {
      if (!seenIds.has(article.id) && article.fullTextPDF) {
        seenIds.add(article.id)
        collectedArticles.push(article)
      }
    }
  }

  // Step 3: Fallback - fill remaining with any articles
  if (collectedArticles.length < batchSize) {
    const remaining = batchSize - collectedArticles.length
    const fallbackQueryStartedAt = Date.now()
    const fallbackLimit = remaining + seenIds.size
    const fallbackArticles = await getAppDatabaseService().queryJsonBackground<ArticleForConversion>(
      `
      SELECT
        id,
        full_text_pdf AS fullTextPDF,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article a
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT ${fallbackLimit}
    `,
      {...fullTextConversionWorkloadContext, maxResultRows: fallbackLimit},
    )
    fullTextConversionLogger.log(
      'fullTextConversion:fallbackArticlesQueried',
      '[fullTextConversion] Fallback articles queried',
      {
        component: fullTextConversionComponent,
        durationMs: Date.now() - fallbackQueryStartedAt,
        remaining,
        resultCount: fallbackArticles.length,
        seenArticleCount: seenIds.size,
      },
    )

    for (const article of fallbackArticles) {
      if (collectedArticles.length >= batchSize) break
      if (!seenIds.has(article.id) && article.fullTextPDF) {
        seenIds.add(article.id)
        collectedArticles.push(article)
      }
    }
  }

  fullTextConversionLogger.log(
    'fullTextConversion:articlesSelected',
    '[fullTextConversion] Articles selected for conversion',
    {
      batchSize,
      component: fullTextConversionComponent,
      durationMs: Date.now() - startedAt,
      resultCount: collectedArticles.length,
    },
  )

  return collectedArticles
}

const runConversionWorker = async ({
  queue,
  runtimeConfig,
}: {
  queue: ArticleForConversion[]
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<void> => {
  const article = queue.pop()
  if (!article) return
  await convertArticle({article, runtimeConfig})
  return runConversionWorker({queue, runtimeConfig})
}

const convertArticles = async ({
  articles,
  concurrency,
  runtimeConfig,
}: {
  articles: ArticleForConversion[]
  concurrency: number
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<void> => {
  const workerCount = Math.min(concurrency, articles.length)
  const queue = articles.slice()

  const results = await Promise.allSettled(
    Array.from({length: workerCount}, () => {
      return runConversionWorker({queue, runtimeConfig})
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
}

const convertArticle = async ({
  article,
  runtimeConfig,
}: {
  article: ArticleForConversion
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<void> => {
  const startTime = Date.now()
  fullTextConversionLogger.log(
    'fullTextConversion:articleConversionStarted',
    '[fullTextConversion] Article conversion started',
    {articleId: article.id, component: fullTextConversionComponent, modelName: runtimeConfig.modelName},
  )

  try {
    const {md, html} = await convertPdfToText({
      baseURL: runtimeConfig.baseURL,
      localPath: article.fullTextPDF,
      timeoutMs: DOCLING_CONVERSION_TIMEOUT_MS,
    })

    const sourceUpdatedAt = new Date()

    await getAppDatabaseService().transaction(async (tx) => {
      await tx.run(`
        UPDATE app.article
        SET full_text = ${getSqlLiteral(md)},
            full_text_html = ${getSqlLiteral(html)},
            full_text_conversion_status = 'success',
            full_text_conversion_error = NULL,
            full_text_conversion_model_id = ${getSqlLiteral(runtimeConfig.modelId)},
            full_text_conversion_metadata = ${getJsonSqlLiteral({
              baseURL: runtimeConfig.baseURL,
              modelId: runtimeConfig.modelId,
              modelName: runtimeConfig.modelName,
              providerKind: runtimeConfig.providerKind,
            })},
            full_text_char_count = ${md.length},
            full_text_conversion_attempts = ${(article.fullTextConversionAttempts ?? 0) + 1},
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(article.id)}'
      `)
      await appendArticleReviewServingDeltas(tx, {
        articleId: article.id,
        changedFields: ['fullText', 'fullTextHtml'],
        sourceMutationKey: `fullTextConversionJobs|article|${article.id}|success|${sourceUpdatedAt.toISOString()}|${getArticleReviewServingMutationValueHash({html, md})}`,
        sourceOperation: 'update',
        sourceUpdatedAt,
      })
    }, fullTextConversionWorkloadContext)

    fullTextConversionLogger.log(
      'fullTextConversion:articleConversionSucceeded',
      '[fullTextConversion] Article conversion succeeded',
      {
        articleId: article.id,
        charCount: md.length,
        component: fullTextConversionComponent,
        durationMs: Date.now() - startTime,
        modelName: runtimeConfig.modelName,
      },
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const msg = errorMessage.toLowerCase()

    // Permanent errors
    const isPerm =
      (error instanceof ConversionError && error.isPermanent)
      || msg.includes('encrypted')
      || msg.includes('password')
      || msg.includes('invalid pdf')
      || msg.includes('file not found')

    const attempts = (article.fullTextConversionAttempts ?? 0) + 1
    const isFinalFailure = isPerm || attempts >= MAX_CONVERSION_ATTEMPTS

    await getAppDatabaseService().runBackground(
      `
      UPDATE app.article
      SET full_text_conversion_status = ${isFinalFailure ? `'failed'` : 'NULL'},
          full_text_conversion_error = ${getSqlLiteral(errorMessage)},
          full_text_conversion_model_id = ${getSqlLiteral(runtimeConfig.modelId)},
          full_text_conversion_metadata = ${getJsonSqlLiteral({
            baseURL: runtimeConfig.baseURL,
            modelId: runtimeConfig.modelId,
            modelName: runtimeConfig.modelName,
            providerKind: runtimeConfig.providerKind,
          })},
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
}

// Counter to track how many batches are currently running
let runningBatches = 0

const runConversionBatch = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON || !shouldCurrentServerRunMaintenanceLoops()) return

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
    const runtimeConfig = await getUserConfigQueryService().getFullTextConversionModelConfig()

    if (!shouldCurrentServerRunMaintenanceLoops()) return

    if (!runtimeConfig) {
      fullTextConversionLogger.log(
        'fullTextConversion:modelConfigMissing',
        '[fullTextConversion] No PDF conversion model configured',
        {batchNumber, component: fullTextConversionComponent},
      )
      return
    }

    fullTextConversionLogger.log('fullTextConversion:batchStarted', '[fullTextConversion] Conversion batch started', {
      batchNumber,
      batchSize,
      component: fullTextConversionComponent,
      concurrency,
      maxConcurrentBatches: MAX_CONCURRENT_BATCHES,
      modelName: runtimeConfig.modelName,
      runningBatches,
    })

    const articles = await getArticlesNeedingConversion(batchSize)

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

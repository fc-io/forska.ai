import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {getJsonSqlLiteral} from '../providers/providerDbUtils.ts'
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
import {shouldCurrentServerRunWriterWork} from '../utils/serverRuntimeRole.ts'

const CONVERSION_INTERVAL = '0 */2 * * * *' // Every 2 minutes
const DOCLING_CONVERSION_TIMEOUT_MS = 600_000 // 10 minutes
const MAX_CONVERSION_ATTEMPTS = 3
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_CONCURRENCY = 1
// Maximum number of concurrent batch runs allowed
const MAX_CONCURRENT_BATCHES = 3

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

  console.time('[fullTextConversion] getArticlesNeedingConversion total')

  // Base conditions: has PDF, no fullText, not failed, not exceeded retry limit
  const baseConditions = [
    `a.full_text_pdf IS NOT NULL`,
    `(a.full_text IS NULL OR a.full_text_html IS NULL)`,
    `(a.full_text_conversion_status IS NULL OR a.full_text_conversion_status != 'failed')`,
    `(a.full_text_conversion_attempts IS NULL OR a.full_text_conversion_attempts < ${MAX_CONVERSION_ATTEMPTS})`,
  ]

  // Step 1: Get running jobs with their projects
  console.time('[fullTextConversion] query running jobs')
  const runningJobsWithProjects = await getAppDatabaseService().queryJson<{
    jobId: string
    projectId: string
    useFulltext: boolean
    dateFrom: unknown
    dateTo: unknown
  }>(`
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
  `)
  console.timeEnd('[fullTextConversion] query running jobs')

  console.log(`[fullTextConversion] Found ${runningJobsWithProjects.length} running jobs`)

  // Step 2: For each project, find articles needing conversion
  for (const {projectId, useFulltext, dateFrom, dateTo} of runningJobsWithProjects) {
    if (collectedArticles.length >= batchSize) break

    const remaining = batchSize - collectedArticles.length
    console.log(`[fullTextConversion] Project ${projectId} (useFulltext=${useFulltext}), need ${remaining} more`)

    // Build date conditions
    const dateConditions = [
      dateFrom ? `a.article_created_at >= ${getTimestampLiteral(getDateValue(dateFrom) ?? new Date(0))}` : null,
      dateTo ? `a.article_created_at <= ${getTimestampLiteral(getDateValue(dateTo) ?? new Date(0))}` : null,
    ].filter((part): part is string => {
      return part !== null
    })

    // Try importRoute path first
    const projectRoutes = await getAppDatabaseService().queryJson<{importRouteId: string}>(`
      SELECT import_route_id AS importRouteId
      FROM app.project_import_route
      WHERE project_id = '${escapeSqlString(projectId)}'
    `)

    if (projectRoutes.length > 0) {
      const routeIds = projectRoutes.map((r) => {
        return r.importRouteId
      })
      const articlesViaRoute = await getAppDatabaseService().queryJson<ArticleForConversion>(`
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
      `)

      for (const article of articlesViaRoute) {
        if (!seenIds.has(article.id) && article.fullTextPDF) {
          seenIds.add(article.id)
          collectedArticles.push(article)
        }
      }
      continue
    }

    // Try project_articles path
    const articlesViaDirect = await getAppDatabaseService().queryJson<ArticleForConversion>(`
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
    `)

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
    console.log(`[fullTextConversion] Fallback: fetching ${remaining} more articles`)
    const fallbackArticles = await getAppDatabaseService().queryJson<ArticleForConversion>(`
      SELECT
        id,
        full_text_pdf AS fullTextPDF,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article a
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT ${remaining + seenIds.size}
    `)

    for (const article of fallbackArticles) {
      if (collectedArticles.length >= batchSize) break
      if (!seenIds.has(article.id) && article.fullTextPDF) {
        seenIds.add(article.id)
        collectedArticles.push(article)
      }
    }
  }

  console.timeEnd('[fullTextConversion] getArticlesNeedingConversion total')
  console.log(`[fullTextConversion] Returning ${collectedArticles.length} articles for conversion`)

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
    console.error('[fullTextConversion] Worker failures', {total: results.length, rejected: rejected.length})
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
  console.log(`[fullTextConversion] Converting article ${article.id} with ${runtimeConfig.modelName}`)

  try {
    const {md, html} = await convertPdfToText({
      baseURL: runtimeConfig.baseURL,
      localPath: article.fullTextPDF,
      timeoutMs: DOCLING_CONVERSION_TIMEOUT_MS,
    })

    await getAppDatabaseService().run(`
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

    console.log(`[fullTextConversion] Success: article ${article.id} (${Date.now() - startTime}ms, ${md.length} chars)`)
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

    await getAppDatabaseService().run(`
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
    `)

    console.log(`[fullTextConversion] ${isFinalFailure ? 'Failed' : 'Retry'}: article ${article.id} - ${errorMessage}`)
  }
}

// Counter to track how many batches are currently running
let runningBatches = 0

const runConversionBatch = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON || !shouldCurrentServerRunWriterWork()) return

  if (runningBatches >= MAX_CONCURRENT_BATCHES) {
    console.log(
      `[fullTextConversion] Max concurrent batches reached (${runningBatches}/${MAX_CONCURRENT_BATCHES}), skipping`,
    )
    return
  }

  runningBatches++
  const batchNumber = runningBatches
  try {
    const batchSize = getConversionBatchSize()
    const concurrency = getConversionConcurrency(batchSize)
    const runtimeConfig = await getUserConfigQueryService().getFullTextConversionModelConfig()

    if (!runtimeConfig) {
      console.log('[fullTextConversion] No PDF conversion model configured, skipping batch')
      return
    }

    console.log(
      `[fullTextConversion] Starting batch #${batchNumber} (size=${batchSize}, concurrency=${concurrency}, model=${runtimeConfig.modelName}, running=${runningBatches}/${MAX_CONCURRENT_BATCHES})`,
    )

    const articles = await getArticlesNeedingConversion(batchSize)

    if (articles.length === 0) {
      console.log(`[fullTextConversion] Batch #${batchNumber}: No articles to convert`)
      return
    }

    await convertArticles({articles, concurrency, runtimeConfig})
  } finally {
    runningBatches--
  }
}

export const fullTextConversionJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-convert-pdfs', pattern: CONVERSION_INTERVAL, run: runConversionBatch}),
)

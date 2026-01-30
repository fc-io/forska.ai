import {cron} from '@elysiajs/cron'
import {and, desc, eq, inArray, isNotNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {ConversionError, convertPdfToText} from '../utils/convertPdfToText.ts'
import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'

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

/**
 * Get articles with PDFs that need conversion, prioritizing:
 * 1. Articles from projects with running jobs + useFulltext=true
 * 2. Articles from projects with running jobs + useFulltext=false
 * 3. Fallback: any articles by created_at DESC
 */
const getArticlesNeedingConversion = async (
  db: PostgresJsDatabase<typeof schema>,
  batchSize: number,
): Promise<ArticleForConversion[]> => {
  const collectedArticles: ArticleForConversion[] = []
  const seenIds = new Set<string>()

  console.time('[fullTextConversion] getArticlesNeedingConversion total')

  // Base conditions: has PDF, no fullText, not failed, not exceeded retry limit
  const baseConditions = [
    isNotNull(schema.articles.fullTextPDF),
    sql`(${schema.articles.fullText} IS NULL OR ${schema.articles.fullTextHtml} IS NULL)`,
    sql`(${schema.articles.fullTextConversionStatus} IS NULL OR ${schema.articles.fullTextConversionStatus} != 'failed')`,
    sql`(${schema.articles.fullTextConversionAttempts} IS NULL OR ${schema.articles.fullTextConversionAttempts} < ${MAX_CONVERSION_ATTEMPTS})`,
  ]

  // Step 1: Get running jobs with their projects
  console.time('[fullTextConversion] query running jobs')
  const runningJobsWithProjects = await db
    .select({
      jobId: schema.judgmentsJobs.id,
      projectId: schema.projects.id,
      useFulltext: schema.projects.useFulltext,
      dateFrom: schema.projects.dateFrom,
      dateTo: schema.projects.dateTo,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
    .where(eq(schema.judgmentsJobs.status, 'running'))
    .orderBy(desc(schema.projects.useFulltext))
  console.timeEnd('[fullTextConversion] query running jobs')

  console.log(`[fullTextConversion] Found ${runningJobsWithProjects.length} running jobs`)

  // Step 2: For each project, find articles needing conversion
  for (const {projectId, useFulltext, dateFrom, dateTo} of runningJobsWithProjects) {
    if (collectedArticles.length >= batchSize) break

    const remaining = batchSize - collectedArticles.length
    console.log(`[fullTextConversion] Project ${projectId} (useFulltext=${useFulltext}), need ${remaining} more`)

    // Build date conditions
    const dateConditions = []
    if (dateFrom) {
      dateConditions.push(sql`${schema.articles.articleCreatedAt} >= ${dateFrom}`)
    }
    if (dateTo) {
      dateConditions.push(sql`${schema.articles.articleCreatedAt} <= ${dateTo}`)
    }

    // Try importRoute path first
    const projectRoutes = await db
      .select({importRouteId: schema.projectRouteLink.importRouteId})
      .from(schema.projectRouteLink)
      .where(eq(schema.projectRouteLink.projectId, projectId))

    if (projectRoutes.length > 0) {
      const routeIds = projectRoutes.map((r) => {
        return r.importRouteId
      })
      const articlesViaRoute = await db
        .select({
          id: schema.articles.id,
          fullTextPDF: schema.articles.fullTextPDF,
          fullTextConversionAttempts: schema.articles.fullTextConversionAttempts,
        })
        .from(schema.articles)
        .innerJoin(schema.articleRouteLink, eq(schema.articleRouteLink.articleId, schema.articles.id))
        .where(and(inArray(schema.articleRouteLink.importRouteId, routeIds), ...baseConditions, ...dateConditions))
        .orderBy(desc(schema.articles.articleCreatedAt))
        .limit(remaining)

      for (const article of articlesViaRoute) {
        if (!seenIds.has(article.id) && article.fullTextPDF) {
          seenIds.add(article.id)
          collectedArticles.push(article as ArticleForConversion)
        }
      }
      continue
    }

    // Try project_articles path
    const articlesViaDirect = await db
      .select({
        id: schema.articles.id,
        fullTextPDF: schema.articles.fullTextPDF,
        fullTextConversionAttempts: schema.articles.fullTextConversionAttempts,
      })
      .from(schema.articles)
      .innerJoin(schema.projectArticles, eq(schema.projectArticles.articleId, schema.articles.id))
      .where(and(eq(schema.projectArticles.projectId, projectId), ...baseConditions, ...dateConditions))
      .orderBy(desc(schema.articles.articleCreatedAt))
      .limit(remaining)

    for (const article of articlesViaDirect) {
      if (!seenIds.has(article.id) && article.fullTextPDF) {
        seenIds.add(article.id)
        collectedArticles.push(article as ArticleForConversion)
      }
    }
  }

  // Step 3: Fallback - fill remaining with any articles
  if (collectedArticles.length < batchSize) {
    const remaining = batchSize - collectedArticles.length
    console.log(`[fullTextConversion] Fallback: fetching ${remaining} more articles`)
    const fallbackArticles = await db
      .select({
        id: schema.articles.id,
        fullTextPDF: schema.articles.fullTextPDF,
        fullTextConversionAttempts: schema.articles.fullTextConversionAttempts,
      })
      .from(schema.articles)
      .where(and(...baseConditions))
      .orderBy(desc(schema.articles.createdAt))
      .limit(remaining + seenIds.size)

    for (const article of fallbackArticles) {
      if (collectedArticles.length >= batchSize) break
      if (!seenIds.has(article.id) && article.fullTextPDF) {
        seenIds.add(article.id)
        collectedArticles.push(article as ArticleForConversion)
      }
    }
  }

  console.timeEnd('[fullTextConversion] getArticlesNeedingConversion total')
  console.log(`[fullTextConversion] Returning ${collectedArticles.length} articles for conversion`)

  return collectedArticles
}

const runConversionWorker = async (
  db: PostgresJsDatabase<typeof schema>,
  queue: ArticleForConversion[],
): Promise<void> => {
  const article = queue.pop()
  if (!article) return
  await convertArticle(db, article)
  return runConversionWorker(db, queue)
}

const convertArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  articles: ArticleForConversion[],
  concurrency: number,
): Promise<void> => {
  const workerCount = Math.min(concurrency, articles.length)
  const queue = articles.slice()

  const results = await Promise.allSettled(
    Array.from({length: workerCount}, () => {
      return runConversionWorker(db, queue)
    }),
  )

  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  })

  if (rejected.length > 0) {
    console.error('[fullTextConversion] Worker failures', {total: results.length, rejected: rejected.length})
  }
}

const convertArticle = async (db: PostgresJsDatabase<typeof schema>, article: ArticleForConversion): Promise<void> => {
  const startTime = Date.now()
  console.log(`[fullTextConversion] Converting article ${article.id}`)

  try {
    const {md, html} = await convertPdfToText(article.fullTextPDF, DOCLING_CONVERSION_TIMEOUT_MS)

    await db
      .update(schema.articles)
      .set({
        fullText: md,
        fullTextHtml: html,
        fullTextConversionStatus: 'success',
        fullTextConversionError: null,
        fullTextCharCount: md.length,
        fullTextConversionAttempts: (article.fullTextConversionAttempts ?? 0) + 1,
      })
      .where(eq(schema.articles.id, article.id))

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

    await db
      .update(schema.articles)
      .set({
        fullTextConversionStatus: isFinalFailure ? 'failed' : sql`NULL`,
        fullTextConversionError: errorMessage,
        fullTextConversionAttempts: attempts,
      })
      .where(eq(schema.articles.id, article.id))

    console.log(`[fullTextConversion] ${isFinalFailure ? 'Failed' : 'Retry'}: article ${article.id} - ${errorMessage}`)
  }
}

// Counter to track how many batches are currently running
let runningBatches = 0

const runConversionBatch = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON) return

  if (runningBatches >= MAX_CONCURRENT_BATCHES) {
    console.log(
      `[fullTextConversion] Max concurrent batches reached (${runningBatches}/${MAX_CONCURRENT_BATCHES}), skipping`,
    )
    return
  }

  runningBatches++
  const batchNumber = runningBatches
  try {
    const db = getDatabase()

    const batchSize = getConversionBatchSize()
    const concurrency = getConversionConcurrency(batchSize)

    console.log(
      `[fullTextConversion] Starting batch #${batchNumber} (size=${batchSize}, concurrency=${concurrency}, running=${runningBatches}/${MAX_CONCURRENT_BATCHES})`,
    )

    const articles = await getArticlesNeedingConversion(db, batchSize)

    if (articles.length === 0) {
      console.log(`[fullTextConversion] Batch #${batchNumber}: No articles to convert`)
      return
    }

    await convertArticles(db, articles, concurrency)
  } finally {
    runningBatches--
  }
}

export const fullTextConversionJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-convert-pdfs', pattern: CONVERSION_INTERVAL, run: runConversionBatch}),
)

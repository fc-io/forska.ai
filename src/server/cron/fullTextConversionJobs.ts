import {cron} from '@elysiajs/cron'
import {and, desc, eq, inArray, isNotNull, isNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {ConversionError, convertPdfToText} from '../utils/convertPdfToText.ts'
import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'

const CONVERSION_INTERVAL = '*/10 * * * * *' // Every 10 seconds
const DOCLING_CONVERSION_TIMEOUT_MS = 60_000 // 60 seconds - a const, not an env var
const MAX_CONVERSION_ATTEMPTS = 3
const BATCH_SIZE = 1 // Convert 5 articles per batch

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
    isNull(schema.articles.fullText),
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

const convertArticle = async (db: PostgresJsDatabase<typeof schema>, article: ArticleForConversion): Promise<void> => {
  const startTime = Date.now()
  console.log(`[fullTextConversion] Converting article ${article.id}`)

  try {
    const convertedText = await convertPdfToText(article.fullTextPDF, DOCLING_CONVERSION_TIMEOUT_MS)

    await db
      .update(schema.articles)
      .set({
        fullText: convertedText,
        fullTextConversionStatus: 'success',
        fullTextCharCount: convertedText.length,
        fullTextConversionAttempts: (article.fullTextConversionAttempts ?? 0) + 1,
      })
      .where(eq(schema.articles.id, article.id))

    console.log(
      `[fullTextConversion] Success: article ${article.id} (${Date.now() - startTime}ms, ${convertedText.length} chars)`,
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
    const finalStatus = isPerm || attempts >= MAX_CONVERSION_ATTEMPTS ? 'failed' : 'pending'

    await db
      .update(schema.articles)
      .set({
        fullTextConversionStatus: finalStatus,
        fullTextConversionError: errorMessage,
        fullTextConversionAttempts: attempts,
      })
      .where(eq(schema.articles.id, article.id))

    console.log(
      `[fullTextConversion] ${finalStatus === 'failed' ? 'Failed' : 'Retry'}: article ${article.id} - ${errorMessage}`,
    )
  }
}

// Flag to prevent overlapping batch runs
let isRunning = false

const runConversionBatch = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_CONVERSION_CRON) return

  if (isRunning) {
    console.log('[fullTextConversion] Previous batch still running, skipping')
    return
  }

  isRunning = true
  try {
    const db = getDatabase()

    const articles = await getArticlesNeedingConversion(db, BATCH_SIZE)

    if (articles.length === 0) {
      console.log('[fullTextConversion] No articles to convert')
      return
    }

    // Convert sequentially to avoid overloading Docling
    for (const article of articles) {
      await convertArticle(db, article)
    }
  } finally {
    isRunning = false
  }
}

export const fullTextConversionJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-convert-pdfs', pattern: CONVERSION_INTERVAL, run: runConversionBatch}),
)

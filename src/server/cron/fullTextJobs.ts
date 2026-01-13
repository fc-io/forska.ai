import {cron} from '@elysiajs/cron'
import {and, desc, eq, inArray, isNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {fullTextArticleFetchFromArxiv} from './fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromUnpaywall} from './fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from './fullTextJobs/pdfFetchTypes.ts'

const NEW_ARTICLES_INTERVAL = '0 * * * * *'

type ArticleResult = {id: string; arxivId: string | null; originalData: unknown}

/**
 * Get articles without full text, prioritizing:
 * 1. Articles from projects with running jobs + useFulltext=true
 * 2. Articles from projects with running jobs + useFulltext=false
 * 3. Fallback: any articles by created_at DESC
 */
const getArticlesWithoutFullText = async (
  db: PostgresJsDatabase<typeof schema>,
  numberOfArticlesToFetch: number,
): Promise<ArticleResult[]> => {
  const collectedArticles: ArticleResult[] = []
  const seenIds = new Set<string>()

  console.time('[fullTextJobs] getArticlesWithoutFullText total')

  // Step 1: Get running jobs with their projects
  console.time('[fullTextJobs] query running jobs')
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
  console.timeEnd('[fullTextJobs] query running jobs')

  console.log(`[fullTextJobs] Found ${runningJobsWithProjects.length} running jobs`)

  // Step 2: For each project, find articles without full text
  for (const {projectId, useFulltext, dateFrom, dateTo} of runningJobsWithProjects) {
    if (collectedArticles.length >= numberOfArticlesToFetch) break

    const remaining = numberOfArticlesToFetch - collectedArticles.length
    console.log(`[fullTextJobs] Project ${projectId} (useFulltext=${useFulltext}), need ${remaining} more`)

    // Build date conditions
    const dateConditions = []
    if (dateFrom) {
      dateConditions.push(sql`${schema.articles.articleCreatedAt} >= ${dateFrom}`)
    }
    if (dateTo) {
      dateConditions.push(sql`${schema.articles.articleCreatedAt} <= ${dateTo}`)
    }

    // Try importRoute path first
    console.time(`[fullTextJobs] project ${projectId} importRoute query`)
    const projectRoutes = await db
      .select({importRouteId: schema.projectRouteLink.importRouteId})
      .from(schema.projectRouteLink)
      .where(eq(schema.projectRouteLink.projectId, projectId))
    console.timeEnd(`[fullTextJobs] project ${projectId} importRoute query`)

    if (projectRoutes.length > 0) {
      const routeIds = projectRoutes.map((r) => {
        return r.importRouteId
      })
      console.time(`[fullTextJobs] project ${projectId} articles via importRoute`)
      const articlesViaRoute = await db
        .select({id: schema.articles.id, arxivId: schema.articles.arxivId, originalData: schema.articles.originalData})
        .from(schema.articles)
        .innerJoin(schema.articleRouteLink, eq(schema.articleRouteLink.articleId, schema.articles.id))
        .where(
          and(
            inArray(schema.articleRouteLink.importRouteId, routeIds),
            isNull(schema.articles.fullTextFetchedAt),
            ...dateConditions,
          ),
        )
        .orderBy(desc(schema.articles.articleCreatedAt))
        .limit(remaining)
      console.timeEnd(`[fullTextJobs] project ${projectId} articles via importRoute`)

      for (const article of articlesViaRoute) {
        if (!seenIds.has(article.id)) {
          seenIds.add(article.id)
          collectedArticles.push(article)
        }
      }
      continue
    }

    // Try project_articles path
    console.time(`[fullTextJobs] project ${projectId} articles via project_articles`)
    const articlesViaDirect = await db
      .select({id: schema.articles.id, arxivId: schema.articles.arxivId, originalData: schema.articles.originalData})
      .from(schema.articles)
      .innerJoin(schema.projectArticles, eq(schema.projectArticles.articleId, schema.articles.id))
      .where(
        and(
          eq(schema.projectArticles.projectId, projectId),
          isNull(schema.articles.fullTextFetchedAt),
          ...dateConditions,
        ),
      )
      .orderBy(desc(schema.articles.articleCreatedAt))
      .limit(remaining)
    console.timeEnd(`[fullTextJobs] project ${projectId} articles via project_articles`)

    for (const article of articlesViaDirect) {
      if (!seenIds.has(article.id)) {
        seenIds.add(article.id)
        collectedArticles.push(article)
      }
    }
  }

  // Step 3: Fallback - fill remaining with any articles
  if (collectedArticles.length < numberOfArticlesToFetch) {
    const remaining = numberOfArticlesToFetch - collectedArticles.length
    console.log(`[fullTextJobs] Fallback: fetching ${remaining} more articles`)
    console.time('[fullTextJobs] fallback query')
    const fallbackArticles = await db
      .select({id: schema.articles.id, arxivId: schema.articles.arxivId, originalData: schema.articles.originalData})
      .from(schema.articles)
      .where(isNull(schema.articles.fullTextFetchedAt))
      .orderBy(desc(schema.articles.createdAt))
      .limit(remaining + seenIds.size) // fetch extra to account for already-seen
    console.timeEnd('[fullTextJobs] fallback query')

    for (const article of fallbackArticles) {
      if (collectedArticles.length >= numberOfArticlesToFetch) break
      if (!seenIds.has(article.id)) {
        seenIds.add(article.id)
        collectedArticles.push(article)
      }
    }
  }

  console.timeEnd('[fullTextJobs] getArticlesWithoutFullText total')
  console.log(`[fullTextJobs] Returning ${collectedArticles.length} articles`)

  return collectedArticles
}

/**
 * Fetch PDF for an article, trying all sources and collecting attempt results.
 * Returns the legacy format for backward compatibility with storeFullText.
 */
const getFullTextForArticle = async (
  articleData: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>,
) => {
  const fetchSources = [fullTextArticleFetchFromUnpaywall, fullTextArticleFetchFromArxiv]
  const attempts: PdfFetchAttemptResult[] = []

  for (const fetchSource of fetchSources) {
    const attempt = await fetchSource(articleData)
    attempts.push(attempt)

    // Short-circuit on first success (same behavior as before)
    if (attempt.success && attempt.result) {
      break
    }
  }

  return attemptsToLegacyResult(attempts)
}

const storeFullText = async (
  db: PostgresJsDatabase<typeof schema>,
  id: (typeof schema.articles.$inferSelect)['id'],
  fullText: NonNullable<Awaited<ReturnType<typeof getFullTextForArticle>>>,
) => {
  await db
    .update(schema.articles)
    .set({
      // fullText: fullText.fullText ?? null,
      fullTextSource: fullText.fullTextSource,
      fullTextOriginalFormat: fullText.fullTextOriginalFormat,
      // fullTextAssets: fullText.fullTextAssets ?? null,
      fullTextPDF: fullText.fullTextPDF,
      fullTextFetchedAt: new Date(),
    })
    .where(eq(schema.articles.id, id))
}

const fetchFullTextForArticles = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_FETCHING) return
  const minutesInADay = 24 * 60
  const unpaywallArticlesPerDayLimit = 100_000
  const numberOfArticlesToFetch = Math.floor(unpaywallArticlesPerDayLimit / minutesInADay)
  const db = getDatabase()
  const articlesWithoutFullText = await getArticlesWithoutFullText(db, numberOfArticlesToFetch)
  await Promise.all(
    articlesWithoutFullText.map(async (articleData) => {
      const fullTextData = await getFullTextForArticle(articleData)
      await storeFullText(db, articleData.id, fullTextData)
    }),
  )
}

export const fullTextJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: fetchFullTextForArticles}),
)

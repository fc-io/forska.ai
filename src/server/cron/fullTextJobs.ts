import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {env} from '../utils/env.ts'
import {shouldCurrentServerRunWriterWork} from '../utils/serverRuntimeRole.ts'
import {fullTextArticleFetchFromArxiv} from './fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromOriginalUrls} from './fullTextJobs/fullTextArticleFetchFromOriginalUrls.ts'
import {fullTextArticleFetchFromUnpaywall} from './fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from './fullTextJobs/pdfFetchTypes.ts'

const NEW_ARTICLES_INTERVAL = '0 * * * * *'

type ArticleResult = {
  id: string
  arxivId: string | null
  doi: string | null
  sourceMetadata: ReturnType<typeof getArticleSourceMetadataValue>
}

/**
 * Get articles without full text, prioritizing:
 * 1. Articles from projects with running jobs + useFulltext=true
 * 2. Articles from projects with running jobs + useFulltext=false
 * 3. Fallback: any articles by created_at DESC
 */
const getArticlesWithoutFullText = async (numberOfArticlesToFetch: number): Promise<ArticleResult[]> => {
  const collectedArticles: ArticleResult[] = []
  const seenIds = new Set<string>()

  console.time('[fullTextJobs] getArticlesWithoutFullText total')

  // Step 1: Get running jobs with their projects
  console.time('[fullTextJobs] query running jobs')
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
  console.timeEnd('[fullTextJobs] query running jobs')

  console.log(`[fullTextJobs] Found ${runningJobsWithProjects.length} running jobs`)

  // Step 2: For each project, find articles without full text
  for (const {projectId, useFulltext, dateFrom, dateTo} of runningJobsWithProjects) {
    if (collectedArticles.length >= numberOfArticlesToFetch) break

    const remaining = numberOfArticlesToFetch - collectedArticles.length
    console.log(`[fullTextJobs] Project ${projectId} (useFulltext=${useFulltext}), need ${remaining} more`)

    // Build date conditions
    const dateConditions = [
      dateFrom ? `a.article_created_at >= ${getTimestampLiteral(getDateValue(dateFrom) ?? new Date(0))}` : null,
      dateTo ? `a.article_created_at <= ${getTimestampLiteral(getDateValue(dateTo) ?? new Date(0))}` : null,
    ].filter((part): part is string => {
      return part !== null
    })

    // Try importRoute path first
    console.time(`[fullTextJobs] project ${projectId} importRoute query`)
    const projectRoutes = await getAppDatabaseService().queryJson<{importRouteId: string}>(`
      SELECT import_route_id AS importRouteId
      FROM app.project_import_route
      WHERE project_id = '${escapeSqlString(projectId)}'
    `)
    console.timeEnd(`[fullTextJobs] project ${projectId} importRoute query`)

    if (projectRoutes.length > 0) {
      const routeIds = projectRoutes.map((r) => {
        return r.importRouteId
      })
      console.time(`[fullTextJobs] project ${projectId} articles via importRoute`)
      const articlesViaRoute = await getAppDatabaseService().queryJson<{
        id: string
        arxivId: string | null
        doi: string | null
        sourceMetadata: unknown
      }>(`
        SELECT
          a.id AS id,
          a.arxiv_id AS arxivId,
          a.doi AS doi,
          TO_JSON(a.source_metadata) AS sourceMetadata
        FROM app.article a
        INNER JOIN app.article_import_route air ON air.article_id = a.id
        WHERE air.import_route_id IN (${getQuotedStringList(routeIds).join(', ')})
          AND a.full_text_fetched_at IS NULL
          ${dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ')}` : ''}
        ORDER BY a.article_created_at DESC NULLS LAST
        LIMIT ${remaining}
      `)
      console.timeEnd(`[fullTextJobs] project ${projectId} articles via importRoute`)

      for (const article of articlesViaRoute) {
        if (!seenIds.has(article.id)) {
          seenIds.add(article.id)
          collectedArticles.push({...article, sourceMetadata: getArticleSourceMetadataValue(article.sourceMetadata)})
        }
      }
      continue
    }

    // Try project_articles path
    console.time(`[fullTextJobs] project ${projectId} articles via project_articles`)
    const articlesViaDirect = await getAppDatabaseService().queryJson<{
      id: string
      arxivId: string | null
      doi: string | null
      sourceMetadata: unknown
    }>(`
      SELECT
        a.id AS id,
        a.arxiv_id AS arxivId,
        a.doi AS doi,
        TO_JSON(a.source_metadata) AS sourceMetadata
      FROM app.article a
      INNER JOIN app.project_article pa ON pa.article_id = a.id
      WHERE pa.project_id = '${escapeSqlString(projectId)}'
        AND a.full_text_fetched_at IS NULL
        ${dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ')}` : ''}
      ORDER BY a.article_created_at DESC NULLS LAST
      LIMIT ${remaining}
    `)
    console.timeEnd(`[fullTextJobs] project ${projectId} articles via project_articles`)

    for (const article of articlesViaDirect) {
      if (!seenIds.has(article.id)) {
        seenIds.add(article.id)
        collectedArticles.push({...article, sourceMetadata: getArticleSourceMetadataValue(article.sourceMetadata)})
      }
    }
  }

  // Step 3: Fallback - fill remaining with any articles
  if (collectedArticles.length < numberOfArticlesToFetch) {
    const remaining = numberOfArticlesToFetch - collectedArticles.length
    console.log(`[fullTextJobs] Fallback: fetching ${remaining} more articles`)
    console.time('[fullTextJobs] fallback query')
    const fallbackArticles = await getAppDatabaseService().queryJson<{
      id: string
      arxivId: string | null
      doi: string | null
      sourceMetadata: unknown
    }>(`
      SELECT
        id,
        arxiv_id AS arxivId,
        doi,
        TO_JSON(source_metadata) AS sourceMetadata
      FROM app.article
      WHERE full_text_fetched_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${remaining + seenIds.size}
    `)
    console.timeEnd('[fullTextJobs] fallback query')

    for (const article of fallbackArticles) {
      if (collectedArticles.length >= numberOfArticlesToFetch) break
      if (!seenIds.has(article.id)) {
        seenIds.add(article.id)
        collectedArticles.push({...article, sourceMetadata: getArticleSourceMetadataValue(article.sourceMetadata)})
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
const getFullTextForArticle = async (articleData: Pick<ArticleResult, 'arxivId' | 'doi' | 'sourceMetadata'>) => {
  const fetchSources = [
    fullTextArticleFetchFromOriginalUrls,
    fullTextArticleFetchFromUnpaywall,
    fullTextArticleFetchFromArxiv,
  ]
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

const storeFullText = async (id: string, fullText: NonNullable<Awaited<ReturnType<typeof getFullTextForArticle>>>) => {
  await getAppDatabaseService().run(`
    UPDATE app.article
    SET full_text_source = ${getSqlLiteral(fullText.fullTextSource)},
        full_text_original_format = ${getSqlLiteral(fullText.fullTextOriginalFormat)},
        full_text_pdf = ${getSqlLiteral(fullText.fullTextPDF)},
        full_text_fetched_at = ${getTimestampLiteral(new Date())},
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(id)}'
  `)
}

const fetchFullTextForArticles = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_FETCHING || !shouldCurrentServerRunWriterWork()) return
  const minutesInADay = 24 * 60
  const unpaywallArticlesPerDayLimit = 100_000
  const numberOfArticlesToFetch = Math.floor(unpaywallArticlesPerDayLimit / minutesInADay)
  const articlesWithoutFullText = await getArticlesWithoutFullText(numberOfArticlesToFetch)
  await Promise.all(
    articlesWithoutFullText.map(async (articleData) => {
      const fullTextData = await getFullTextForArticle(articleData)
      await storeFullText(articleData.id, fullTextData)
    }),
  )
}

export const fullTextJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: fetchFullTextForArticles}),
)

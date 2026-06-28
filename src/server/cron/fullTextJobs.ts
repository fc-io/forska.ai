import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
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
import {env} from '../utils/env.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {fullTextArticleFetchFromArxiv} from './fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromOriginalUrls} from './fullTextJobs/fullTextArticleFetchFromOriginalUrls.ts'
import {fullTextArticleFetchFromUnpaywall} from './fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from './fullTextJobs/pdfFetchTypes.ts'

const NEW_ARTICLES_INTERVAL = '0 * * * * *'
const MAX_RUNNING_JOB_PROJECTS_PER_SCAN = 100
const MAX_PROJECT_IMPORT_ROUTES_PER_SCAN = 100
const fullTextFetchLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const fullTextFetchComponent = 'fullTextJobs'
const fullTextFetchWorkloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'fullText.fetch.cron',
  workloadClass: 'background.fullText.fetch',
}

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
  const startedAt = Date.now()

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
    {...fullTextFetchWorkloadContext, maxResultRows: MAX_RUNNING_JOB_PROJECTS_PER_SCAN},
  )

  fullTextFetchLogger.log('fullTextJobs:runningJobsQueried', '[fullTextJobs] Running jobs queried', {
    component: fullTextFetchComponent,
    durationMs: Date.now() - runningJobsQueryStartedAt,
    runningJobCount: runningJobsWithProjects.length,
  })

  // Step 2: For each project, find articles without full text
  for (const {projectId, useFulltext, dateFrom, dateTo} of runningJobsWithProjects) {
    if (collectedArticles.length >= numberOfArticlesToFetch) break

    const remaining = numberOfArticlesToFetch - collectedArticles.length
    fullTextFetchLogger.log('fullTextJobs:projectScanStarted', '[fullTextJobs] Project full-text scan started', {
      collectedArticleCount: collectedArticles.length,
      component: fullTextFetchComponent,
      projectId,
      remaining,
      useFulltext,
    })

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
      {...fullTextFetchWorkloadContext, maxResultRows: MAX_PROJECT_IMPORT_ROUTES_PER_SCAN, projectId},
    )
    fullTextFetchLogger.log('fullTextJobs:projectRoutesQueried', '[fullTextJobs] Project import routes queried', {
      component: fullTextFetchComponent,
      durationMs: Date.now() - projectRoutesQueryStartedAt,
      projectId,
      routeCount: projectRoutes.length,
    })

    if (projectRoutes.length > 0) {
      const routeIds = projectRoutes.map((r) => {
        return r.importRouteId
      })
      const articlesViaRouteQueryStartedAt = Date.now()
      const articlesViaRoute = await getAppDatabaseService().queryJsonBackground<{
        id: string
        arxivId: string | null
        doi: string | null
        sourceMetadata: unknown
      }>(
        `
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
      `,
        {...fullTextFetchWorkloadContext, maxResultRows: remaining, projectId},
      )
      fullTextFetchLogger.log(
        'fullTextJobs:articlesViaImportRouteQueried',
        '[fullTextJobs] Articles via import route queried',
        {
          component: fullTextFetchComponent,
          durationMs: Date.now() - articlesViaRouteQueryStartedAt,
          projectId,
          resultCount: articlesViaRoute.length,
          routeCount: routeIds.length,
        },
      )

      for (const article of articlesViaRoute) {
        if (!seenIds.has(article.id)) {
          seenIds.add(article.id)
          collectedArticles.push({...article, sourceMetadata: getArticleSourceMetadataValue(article.sourceMetadata)})
        }
      }
      continue
    }

    // Try project_articles path
    const articlesViaProjectQueryStartedAt = Date.now()
    const articlesViaDirect = await getAppDatabaseService().queryJsonBackground<{
      id: string
      arxivId: string | null
      doi: string | null
      sourceMetadata: unknown
    }>(
      `
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
    `,
      {...fullTextFetchWorkloadContext, maxResultRows: remaining, projectId},
    )
    fullTextFetchLogger.log('fullTextJobs:articlesViaProjectQueried', '[fullTextJobs] Articles via project queried', {
      component: fullTextFetchComponent,
      durationMs: Date.now() - articlesViaProjectQueryStartedAt,
      projectId,
      resultCount: articlesViaDirect.length,
    })

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
    const fallbackQueryStartedAt = Date.now()
    const fallbackLimit = remaining + seenIds.size
    const fallbackArticles = await getAppDatabaseService().queryJsonBackground<{
      id: string
      arxivId: string | null
      doi: string | null
      sourceMetadata: unknown
    }>(
      `
      SELECT
        id,
        arxiv_id AS arxivId,
        doi,
        TO_JSON(source_metadata) AS sourceMetadata
      FROM app.article
      WHERE full_text_fetched_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${fallbackLimit}
    `,
      {...fullTextFetchWorkloadContext, maxResultRows: fallbackLimit},
    )
    fullTextFetchLogger.log('fullTextJobs:fallbackArticlesQueried', '[fullTextJobs] Fallback articles queried', {
      component: fullTextFetchComponent,
      durationMs: Date.now() - fallbackQueryStartedAt,
      remaining,
      resultCount: fallbackArticles.length,
      seenArticleCount: seenIds.size,
    })

    for (const article of fallbackArticles) {
      if (collectedArticles.length >= numberOfArticlesToFetch) break
      if (!seenIds.has(article.id)) {
        seenIds.add(article.id)
        collectedArticles.push({...article, sourceMetadata: getArticleSourceMetadataValue(article.sourceMetadata)})
      }
    }
  }

  fullTextFetchLogger.log('fullTextJobs:articlesSelected', '[fullTextJobs] Articles selected for full-text fetch', {
    component: fullTextFetchComponent,
    durationMs: Date.now() - startedAt,
    resultCount: collectedArticles.length,
    targetCount: numberOfArticlesToFetch,
  })

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
  await getAppDatabaseService().transaction(async (tx) => {
    const sourceUpdatedAt = new Date()
    await tx.run(`
      UPDATE app.article
      SET full_text_source = ${getSqlLiteral(fullText.fullTextSource)},
          full_text_original_format = ${getSqlLiteral(fullText.fullTextOriginalFormat)},
          full_text_pdf = ${getSqlLiteral(fullText.fullTextPDF)},
          full_text_fetched_at = ${getTimestampLiteral(sourceUpdatedAt)},
          updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
      WHERE id = '${escapeSqlString(id)}'
    `)
    await appendArticleReviewServingDeltas(tx, {
      articleId: id,
      changedFields: fullText.fullTextPDF ? ['fullTextPDF'] : [],
      sourceMutationKey: `fullTextJobs|article|${id}|${sourceUpdatedAt.toISOString()}|${getArticleReviewServingMutationValueHash(fullText)}`,
      sourceOperation: 'update',
      sourceUpdatedAt,
    })
  }, fullTextFetchWorkloadContext)
}

const fetchFullTextForArticles = async () => {
  if (!env.RUN_SERVER_FULL_TEXT_FETCHING || !shouldCurrentServerRunMaintenanceLoops()) return
  try {
    const minutesInADay = 24 * 60
    const unpaywallArticlesPerDayLimit = 100_000
    const numberOfArticlesToFetch = Math.floor(unpaywallArticlesPerDayLimit / minutesInADay)
    const articlesWithoutFullText = await getArticlesWithoutFullText(numberOfArticlesToFetch)

    if (!shouldCurrentServerRunMaintenanceLoops()) return

    await Promise.all(
      articlesWithoutFullText.map(async (articleData) => {
        const fullTextData = await getFullTextForArticle(articleData)
        if (!shouldCurrentServerRunMaintenanceLoops()) return
        await storeFullText(articleData.id, fullTextData)
      }),
    )
  } catch (error) {
    if (!isExpectedDuckdbOwnerRoleLossError(error)) {
      throw error
    }
  }
}

export const fullTextJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: fetchFullTextForArticles}),
)

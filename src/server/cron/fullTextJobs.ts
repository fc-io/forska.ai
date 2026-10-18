import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {env} from '../utils/env.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {fullTextArticleFetchFromArxiv} from './fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromOriginalUrls} from './fullTextJobs/fullTextArticleFetchFromOriginalUrls.ts'
import {fullTextArticleFetchFromUnpaywall} from './fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'
import {
  type FullTextCronProject,
  getFullTextCronGate,
  logFullTextCronGateBlocked,
  selectFullTextCronArticles,
} from './fullTextJobs/fullTextCronScope.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from './fullTextJobs/pdfFetchTypes.ts'

const NEW_ARTICLES_INTERVAL = '0 * * * * *'
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

type ArticleRow = Omit<ArticleResult, 'sourceMetadata'> & {sourceMetadata: unknown}

export const getArticlesWithoutFullText = async ({
  numberOfArticlesToFetch,
  projects,
}: {
  numberOfArticlesToFetch: number
  projects: FullTextCronProject[]
}): Promise<ArticleResult[]> => {
  const startedAt = Date.now()
  const rows = await selectFullTextCronArticles<ArticleRow>({
    articleConditions: ['a.full_text_fetched_at IS NULL'],
    limit: numberOfArticlesToFetch,
    onProjectScanned: ({durationMs, project, resultCount}) => {
      fullTextFetchLogger.log('fullTextJobs:projectScanned', '[fullTextJobs] Project full-text fetch scan', {
        component: fullTextFetchComponent,
        durationMs,
        hasRunningJob: project.hasRunningJob,
        projectId: project.projectId,
        resultCount,
      })
    },
    projects,
    selectColumns: 'a.id AS id, a.arxiv_id AS arxivId, a.doi AS doi, TO_JSON(a.source_metadata) AS sourceMetadata',
    workloadContext: fullTextFetchWorkloadContext,
  })

  fullTextFetchLogger.log('fullTextJobs:articlesSelected', '[fullTextJobs] Articles selected for full-text fetch', {
    component: fullTextFetchComponent,
    durationMs: Date.now() - startedAt,
    projectCount: projects.length,
    resultCount: rows.length,
    targetCount: numberOfArticlesToFetch,
  })

  return rows.map((row) => {
    return {...row, sourceMetadata: getArticleSourceMetadataValue(row.sourceMetadata)}
  })
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

export const logUnpaywallEmailMissing = async (articleCount: number): Promise<boolean> => {
  const isMissing = articleCount > 0 && !(await getUserConfigQueryService().getUnpaywallEmail())

  if (isMissing) {
    fullTextFetchLogger.log(
      'fullTextJobs:unpaywallEmailMissing',
      '[fullTextJobs] No Unpaywall email is set in Settings; PDFs are fetched only from publisher URLs and arXiv',
      {articleCount, component: fullTextFetchComponent},
    )
  }

  return isMissing
}

const fetchFullTextForArticles = async () => {
  if (!shouldCurrentServerRunMaintenanceLoops()) return
  try {
    const gate = await getFullTextCronGate({
      enabled: env.RUN_SERVER_FULL_TEXT_FETCHING,
      workloadContext: fullTextFetchWorkloadContext,
    })

    if (!gate.open) {
      logFullTextCronGateBlocked({component: fullTextFetchComponent, reason: gate.reason})
      return
    }

    const minutesInADay = 24 * 60
    const unpaywallArticlesPerDayLimit = 100_000
    const numberOfArticlesToFetch = Math.floor(unpaywallArticlesPerDayLimit / minutesInADay)
    const articlesWithoutFullText = await getArticlesWithoutFullText({numberOfArticlesToFetch, projects: gate.projects})

    if (!shouldCurrentServerRunMaintenanceLoops()) return

    await logUnpaywallEmailMissing(articlesWithoutFullText.length)
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

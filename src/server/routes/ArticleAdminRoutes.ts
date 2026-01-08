import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles} from '../../db/schema.ts'
import {fullTextArticleFetchFromArxiv} from '../cron/fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromUnpaywall} from '../cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from '../cron/fullTextJobs/pdfFetchTypes.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

/**
 * Fetch PDF for a single article using the same logic as the cron job.
 * This function always attempts to fetch, regardless of whether fullTextFetchedAt is set.
 * Returns both the final result and detailed attempt information for each source.
 */
const fetchPdfForArticle = async (articleData: {arxivId: string | null; originalData: unknown}) => {
  const fetchSources = [fullTextArticleFetchFromUnpaywall, fullTextArticleFetchFromArxiv]
  const attempts: PdfFetchAttemptResult[] = []

  for (const fetchSource of fetchSources) {
    const attempt = await fetchSource(articleData)
    attempts.push(attempt)

    // Short-circuit on first success (same behavior as cron job)
    if (attempt.success && attempt.result) {
      break
    }
  }

  const legacyResult = attemptsToLegacyResult(attempts)

  return {attempts, ...legacyResult}
}

export const articleAdminRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  // Get admin-specific article info (lightweight, for suspense boundary)
  .get(
    '/api/articles/:id/admin-info',
    async ({params}) => {
      const db = getDatabase()
      const {id} = params

      const [article] = await db
        .select({
          id: articles.id,
          fullTextFetchedAt: articles.fullTextFetchedAt,
          fullTextPDF: articles.fullTextPDF,
          fullTextConversionStatus: articles.fullTextConversionStatus,
          fullTextConversionError: articles.fullTextConversionError,
          fullTextConversionAttempts: articles.fullTextConversionAttempts,
        })
        .from(articles)
        .where(eq(articles.id, id))
        .limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      return {article}
    },
    {params: t.Object({id: t.String()})},
  )
  // Force refetch PDF for an article
  .post(
    '/api/articles/:id/fetch-pdf',
    async ({params}) => {
      const db = getDatabase()
      const {id} = params

      // Get the article to access arxivId and originalData
      const [article] = await db
        .select({id: articles.id, arxivId: articles.arxivId, originalData: articles.originalData})
        .from(articles)
        .where(eq(articles.id, id))
        .limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      // Fetch the PDF using the same logic as the cron job
      const result = await fetchPdfForArticle({arxivId: article.arxivId, originalData: article.originalData})

      // Update the article with the fetched PDF info
      const updateData: Record<string, unknown> = {fullTextFetchedAt: new Date()}

      if (result.fullTextPDF) {
        updateData.fullTextPDF = result.fullTextPDF
        updateData.fullTextSource = result.fullTextSource
        updateData.fullTextOriginalFormat = result.fullTextOriginalFormat
        // Reset conversion status so it can be reprocessed
        updateData.fullTextConversionStatus = null
        updateData.fullTextConversionAttempts = 0
        updateData.fullTextConversionError = null
        // Clear existing fullText so conversion will re-run
        updateData.fullText = null
        updateData.fullTextHtml = null
      }

      await db.update(articles).set(updateData).where(eq(articles.id, id))

      return {
        success: true,
        fullTextPDF: result.fullTextPDF,
        fullTextSource: result.fullTextSource,
        attempts: result.attempts,
      }
    },
    {params: t.Object({id: t.String()})},
  )

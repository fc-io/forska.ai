import {eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'
import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import {user} from '../../../auth-schema.ts'
import {auth} from '../../auth.ts'
import {articles} from '../../db/schema.ts'
import {fullTextArticleFetchFromArxiv} from '../cron/fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromUnpaywall} from '../cron/fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from '../cron/fullTextJobs/pdfFetchTypes.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {ConversionError, convertPdfToText} from '../utils/convertPdfToText.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

type OriginalFullTextUrl = {
  url: string
  site: string | null
  availability: string | null
  documentStyle: string | null
  availabilityCode: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringField = (value: Record<string, unknown>, key: string) => {
  const candidate = value[key]
  return typeof candidate === 'string' ? candidate : null
}

const getOriginalFullTextUrls = (originalData: unknown): OriginalFullTextUrl[] => {
  const fullTextUrlList = isRecord(originalData) ? originalData.fullTextUrlList : null
  const fullTextUrl = isRecord(fullTextUrlList) ? fullTextUrlList.fullTextUrl : null
  const entries = Array.isArray(fullTextUrl) ? fullTextUrl : fullTextUrl ? [fullTextUrl] : []

  return entries
    .map((entry): OriginalFullTextUrl | null => {
      const record = isRecord(entry) ? entry : null
      const url = record ? getStringField(record, 'url') : null

      return url
        ? {
            url,
            site: record ? getStringField(record, 'site') : null,
            availability: record ? getStringField(record, 'availability') : null,
            documentStyle: record ? getStringField(record, 'documentStyle') : null,
            availabilityCode: record ? getStringField(record, 'availabilityCode') : null,
          }
        : null
    })
    .filter((v): v is OriginalFullTextUrl => {
      return v !== null
    })
    .slice(0, 25)
}

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

/**
 * Store an uploaded PDF to the user-specific assets folder.
 * Returns the relative path to the stored file, or null on failure.
 */
const storeUploadedPdf = async (userId: string, articleId: string, pdfBuffer: Buffer): Promise<string | null> => {
  const relDir = `assets/user_uploaded_article_pdfs/${userId}`
  const fileName = `${articleId}.pdf`
  const relPath = `${relDir}/${fileName}`
  const absDir = path.join(process.cwd(), relDir)
  const absPath = path.join(absDir, fileName)

  try {
    await mkdir(absDir, {recursive: true})
    await writeFile(absPath, pdfBuffer)
    return relPath
  } catch (error) {
    console.error('Failed to store uploaded PDF:', error)
    return null
  }
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
          fullTextPdfUploadedBy: articles.fullTextPdfUploadedBy,
          fullTextCharCount: articles.fullTextCharCount,
        })
        .from(articles)
        .where(eq(articles.id, id))
        .limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      // If there's an uploader, fetch their name
      let uploaderName: string | null = null
      if (article.fullTextPdfUploadedBy) {
        const [uploader] = await db
          .select({name: user.name})
          .from(user)
          .where(eq(user.id, article.fullTextPdfUploadedBy))
          .limit(1)
        uploaderName = uploader?.name ?? null
      }

      return {article: {...article, uploaderName}}
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
      const originalFullTextUrls = getOriginalFullTextUrls(article.originalData)

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
        // Clear uploaded by since this is an auto-fetched PDF
        updateData.fullTextPdfUploadedBy = null
      }

      await db.update(articles).set(updateData).where(eq(articles.id, id))

      return {
        success: true,
        fullTextPDF: result.fullTextPDF,
        fullTextSource: result.fullTextSource,
        attempts: result.attempts,
        originalFullTextUrls,
      }
    },
    {params: t.Object({id: t.String()})},
  )
  // Upload a PDF for an article
  .post(
    '/api/articles/:id/upload-pdf',
    async ({params, body, request}) => {
      const db = getDatabase()
      const {id} = params

      // Get session directly (consistent with other routes)
      const session = await auth.api.getSession({headers: request.headers})
      const userId = session?.user?.id ?? null
      const role = session?.user?.role ?? null

      if (!userId) {
        throw new Error('You must be signed in')
      }
      if (role !== 'admin') {
        throw new Error('Administrator access required')
      }

      // Check if article exists
      const [article] = await db.select({id: articles.id}).from(articles).where(eq(articles.id, id)).limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      // Get the PDF file from the request body
      const pdfFile = body.pdf
      if (!pdfFile || !(pdfFile instanceof Blob)) {
        throw new Error('No PDF file provided')
      }

      // Validate that it's a PDF
      const fileType = pdfFile.type
      if (!fileType.includes('pdf')) {
        throw new Error('File must be a PDF')
      }

      // Convert to buffer and store
      const arrayBuffer = await pdfFile.arrayBuffer()
      const pdfBuffer = Buffer.from(arrayBuffer)

      const fullTextPDF = await storeUploadedPdf(userId, id, pdfBuffer)

      if (!fullTextPDF) {
        throw new Error('Failed to store PDF file')
      }

      // Update the article with the uploaded PDF info
      await db
        .update(articles)
        .set({
          fullTextPDF,
          fullTextSource: 'user_upload',
          fullTextOriginalFormat: 'pdf',
          fullTextFetchedAt: new Date(),
          fullTextPdfUploadedBy: userId,
          // Reset conversion status so it can be processed
          fullTextConversionStatus: null,
          fullTextConversionAttempts: 0,
          fullTextConversionError: null,
          // Clear existing fullText so conversion will re-run
          fullText: null,
          fullTextHtml: null,
        })
        .where(eq(articles.id, id))

      return {success: true, fullTextPDF, message: 'PDF uploaded successfully'}
    },
    {params: t.Object({id: t.String()}), body: t.Object({pdf: t.File({type: 'application/pdf'})})},
  )
  // Convert PDF to text for an article (async - returns immediately)
  .post(
    '/api/articles/:id/convert-pdf',
    async ({params}) => {
      const db = getDatabase()
      const {id} = params
      const DOCLING_CONVERSION_TIMEOUT_MS = 600_000
      const MAX_CONVERSION_ATTEMPTS = 3

      const [article] = await db
        .select({
          id: articles.id,
          fullTextPDF: articles.fullTextPDF,
          fullTextConversionAttempts: articles.fullTextConversionAttempts,
        })
        .from(articles)
        .where(eq(articles.id, id))
        .limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      if (!article.fullTextPDF) {
        throw new Error('No PDF available for this article')
      }

      await db
        .update(articles)
        .set({fullTextConversionStatus: 'pending', fullTextConversionError: null})
        .where(eq(articles.id, article.id))

      const runConversion = async () => {
        const startTime = Date.now()
        console.log(`[convertPdf] Converting article ${article.id}`)

        try {
          const {md, html} = await convertPdfToText(article.fullTextPDF, DOCLING_CONVERSION_TIMEOUT_MS)

          await db
            .update(articles)
            .set({
              fullText: md,
              fullTextHtml: html,
              fullTextConversionStatus: 'success',
              fullTextCharCount: md.length,
              fullTextConversionAttempts: (article.fullTextConversionAttempts ?? 0) + 1,
            })
            .where(eq(articles.id, article.id))

          const duration = Date.now() - startTime
          console.log(`[convertPdf] Success: article ${article.id} (${duration}ms, ${md.length} chars)`)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          const msg = errorMessage.toLowerCase()

          const isPerm =
            (error instanceof ConversionError && error.isPermanent)
            || msg.includes('encrypted')
            || msg.includes('password')
            || msg.includes('invalid pdf')
            || msg.includes('file not found')

          const attempts = (article.fullTextConversionAttempts ?? 0) + 1
          const finalStatus = isPerm || attempts >= MAX_CONVERSION_ATTEMPTS ? 'failed' : 'pending'

          await db
            .update(articles)
            .set({
              fullTextConversionStatus: finalStatus,
              fullTextConversionError: errorMessage,
              fullTextConversionAttempts: attempts,
            })
            .where(eq(articles.id, article.id))

          console.log(
            `[convertPdf] ${finalStatus === 'failed' ? 'Failed' : 'Retry'}: article ${article.id} - ${errorMessage}`,
          )
        }
      }

      void runConversion()

      return {success: true, message: 'Conversion started', status: 'pending'}
    },
    {params: t.Object({id: t.String()})},
  )

import {Elysia, t} from 'elysia'
import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import {fetchPdfForArticle} from '../cron/fullTextJobs/fetchPdfForArticle.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {ConversionError, convertPdfToText} from '../utils/convertPdfToText.ts'
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
 * Store an uploaded PDF to the local assets folder.
 * Returns the relative path to the stored file, or null on failure.
 */
const storeUploadedPdf = async (articleId: string, pdfBuffer: Buffer): Promise<string | null> => {
  const relDir = 'assets/user_uploaded_article_pdfs'
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
  // Extra article info (lightweight, for suspense boundary)
  .get(
    '/api/articles/:id/admin-info',
    async ({params}) => {
      const {id} = params

      const [article] = await getAppDatabaseService().queryJson<{
        id: string
        fullTextFetchedAt: unknown
        fullTextPDF: string | null
        fullTextSource: string | null
        fullTextConversionStatus: string | null
        fullTextConversionError: string | null
        fullTextConversionAttempts: number | null
        fullTextCharCount: number | null
      }>(`
        SELECT
          id,
          full_text_fetched_at AS fullTextFetchedAt,
          full_text_pdf AS fullTextPDF,
          full_text_source AS fullTextSource,
          full_text_conversion_status AS fullTextConversionStatus,
          full_text_conversion_error AS fullTextConversionError,
          full_text_conversion_attempts AS fullTextConversionAttempts,
          full_text_char_count AS fullTextCharCount
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

      if (!article) {
        throw new Error('Article not found')
      }

      return {article: {...article, fullTextFetchedAt: getDateValue(article.fullTextFetchedAt)}}
    },
    {params: t.Object({id: t.String()})},
  )
  // Force refetch PDF for an article
  .post(
    '/api/articles/:id/fetch-pdf',
    async ({params}) => {
      const {id} = params

      // Get the article to access arxivId and originalData
      const [article] = await getAppDatabaseService().queryJson<{
        id: string
        arxivId: string | null
        originalData: unknown
      }>(`
        SELECT id, arxiv_id AS arxivId, TO_JSON(original_data) AS originalData
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

      if (!article) {
        throw new Error('Article not found')
      }

      // Fetch the PDF using the same logic as the cron job
      const originalData = getJsonValue(article.originalData)
      const result = await fetchPdfForArticle({arxivId: article.arxivId, originalData})
      const originalFullTextUrls = getOriginalFullTextUrls(originalData)

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

      const updateParts = Object.entries(updateData).map(([key, value]) => {
        const columnMap: Record<string, string> = {
          fullTextFetchedAt: 'full_text_fetched_at',
          fullTextPDF: 'full_text_pdf',
          fullTextSource: 'full_text_source',
          fullTextOriginalFormat: 'full_text_original_format',
          fullTextConversionStatus: 'full_text_conversion_status',
          fullTextConversionAttempts: 'full_text_conversion_attempts',
          fullTextConversionError: 'full_text_conversion_error',
          fullText: 'full_text',
          fullTextHtml: 'full_text_html',
        }
        return `${columnMap[key] ?? key} = ${getSqlLiteral(value)}`
      })
      await getAppDatabaseService().run(`
        UPDATE app.article
        SET ${updateParts.join(', ')},
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(id)}'
      `)

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
    async ({params, body}) => {
      const {id} = params

      // Check if article exists
      const [article] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

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

      const fullTextPDF = await storeUploadedPdf(id, pdfBuffer)

      if (!fullTextPDF) {
        throw new Error('Failed to store PDF file')
      }

      // Update the article with the uploaded PDF info
      await getAppDatabaseService().run(`
        UPDATE app.article
        SET full_text_pdf = ${getSqlLiteral(fullTextPDF)},
            full_text_source = 'user_upload',
            full_text_original_format = 'pdf',
            full_text_fetched_at = ${getTimestampLiteral(new Date())},
            full_text_conversion_status = NULL,
            full_text_conversion_attempts = 0,
            full_text_conversion_error = NULL,
            full_text = NULL,
            full_text_html = NULL,
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(id)}'
      `)

      return {success: true, fullTextPDF, message: 'PDF uploaded successfully'}
    },
    {params: t.Object({id: t.String()}), body: t.Object({pdf: t.File({type: 'application/pdf'})})},
  )
  // Convert PDF to text for an article (async - returns immediately)
  .post(
    '/api/articles/:id/convert-pdf',
    async ({params}) => {
      const {id} = params
      const DOCLING_CONVERSION_TIMEOUT_MS = 600_000
      const MAX_CONVERSION_ATTEMPTS = 3

      const [article] = await getAppDatabaseService().queryJson<{
        id: string
        fullTextPDF: string | null
        fullTextConversionAttempts: number | null
      }>(`
        SELECT
          id,
          full_text_pdf AS fullTextPDF,
          full_text_conversion_attempts AS fullTextConversionAttempts
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

      if (!article) {
        throw new Error('Article not found')
      }

      if (!article.fullTextPDF) {
        throw new Error('No PDF available for this article')
      }

      const fullTextPDF = article.fullTextPDF

      await getAppDatabaseService().run(`
        UPDATE app.article
        SET full_text_conversion_status = 'pending',
            full_text_conversion_error = NULL,
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(article.id)}'
      `)

      const runConversion = async () => {
        const startTime = Date.now()
        console.log(`[convertPdf] Converting article ${article.id}`)

        try {
          const {md, html} = await convertPdfToText(fullTextPDF, DOCLING_CONVERSION_TIMEOUT_MS)

          await getAppDatabaseService().run(`
            UPDATE app.article
            SET full_text = ${getSqlLiteral(md)},
                full_text_html = ${getSqlLiteral(html)},
                full_text_conversion_status = 'success',
                full_text_conversion_error = NULL,
                full_text_char_count = ${md.length},
                full_text_conversion_attempts = ${(article.fullTextConversionAttempts ?? 0) + 1},
                updated_at = current_timestamp
            WHERE id = '${escapeSqlString(article.id)}'
          `)

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
          const isFinalFailure = isPerm || attempts >= MAX_CONVERSION_ATTEMPTS

          await getAppDatabaseService().run(`
            UPDATE app.article
            SET full_text_conversion_status = ${isFinalFailure ? `'failed'` : 'NULL'},
                full_text_conversion_error = ${getSqlLiteral(errorMessage)},
                full_text_conversion_attempts = ${attempts},
                updated_at = current_timestamp
            WHERE id = '${escapeSqlString(article.id)}'
          `)

          console.log(`[convertPdf] ${isFinalFailure ? 'Failed' : 'Retry'}: article ${article.id} - ${errorMessage}`)
        }
      }

      void runConversion()

      return {success: true, message: 'Conversion started', status: 'pending'}
    },
    {params: t.Object({id: t.String()})},
  )

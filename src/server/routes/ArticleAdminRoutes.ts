import {Elysia, t} from 'elysia'
import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import {emptyArticleSourceMetadata, getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {fetchPdfForArticle} from '../cron/fullTextJobs/fetchPdfForArticle.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {ConversionError, convertPdfToText} from '../utils/convertPdfToText.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {resolveRuntimeWritablePath} from '../utils/runtimeWritablePath.ts'

/**
 * Store an uploaded PDF to the local assets folder.
 * Returns the relative path to the stored file, or null on failure.
 */
const storeUploadedPdf = async (articleId: string, pdfBuffer: Buffer): Promise<string | null> => {
  const relDir = 'assets/user_uploaded_article_pdfs'
  const fileName = `${articleId}.pdf`
  const relPath = `${relDir}/${fileName}`
  const absDir = resolveRuntimeWritablePath({pathValue: relDir})
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

      // Get the article to access arxivId and source metadata
      const [article] = await getAppDatabaseService().queryJson<{
        id: string
        arxivId: string | null
        doi: string | null
        sourceMetadata: unknown
      }>(`
        SELECT id, arxiv_id AS arxivId, doi, TO_JSON(source_metadata) AS sourceMetadata
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

      if (!article) {
        throw new Error('Article not found')
      }

      // Fetch the PDF using the same logic as the cron job
      const sourceMetadata =
        getArticleSourceMetadataValue(getJsonValue(article.sourceMetadata)) ?? emptyArticleSourceMetadata
      const result = await fetchPdfForArticle({arxivId: article.arxivId, doi: article.doi, sourceMetadata})

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
      await getAppDatabaseService().transaction(async (tx) => {
        const sourceUpdatedAt = new Date()
        await tx.run(`
          UPDATE app.article
          SET ${updateParts.join(', ')},
              updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
          WHERE id = '${escapeSqlString(id)}'
        `)
        await appendArticleReviewServingDeltas(tx, {
          articleId: id,
          changedFields: result.fullTextPDF ? ['fullText', 'fullTextHtml', 'fullTextPDF'] : [],
          sourceMutationKey: `ArticleAdminRoutes.fetchPdf|article|${id}|${sourceUpdatedAt.toISOString()}|${getArticleReviewServingMutationValueHash(result)}`,
          sourceOperation: 'update',
          sourceUpdatedAt,
        })
      })

      return {
        success: true,
        fullTextPDF: result.fullTextPDF,
        fullTextSource: result.fullTextSource,
        attempts: result.attempts,
        fullTextLinks: sourceMetadata.fullTextLinks,
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
      await getAppDatabaseService().transaction(async (tx) => {
        await tx.run(`
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
        await appendArticleReviewServingDeltas(tx, {
          articleId: id,
          changedFields: ['fullText', 'fullTextHtml', 'fullTextPDF'],
          sourceMutationKey: `ArticleAdminRoutes.uploadPdf|article|${id}|${fullTextPDF}|${pdfBuffer.byteLength}|${Date.now()}`,
          sourceOperation: 'update',
        })
      })

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
          const runtimeConfig = await getUserConfigQueryService().getFullTextConversionModelConfig()

          if (!runtimeConfig) {
            throw new Error('No Docling conversion model configured')
          }

          const {md, html} = await convertPdfToText({
            baseURL: runtimeConfig.baseURL,
            localPath: fullTextPDF,
            timeoutMs: DOCLING_CONVERSION_TIMEOUT_MS,
          })
          const sourceUpdatedAt = new Date()

          await getAppDatabaseService().transaction(async (tx) => {
            await tx.run(`
              UPDATE app.article
              SET full_text = ${getSqlLiteral(md)},
                  full_text_html = ${getSqlLiteral(html)},
                  full_text_conversion_status = 'success',
                  full_text_conversion_error = NULL,
                  full_text_char_count = ${md.length},
                  full_text_conversion_attempts = ${(article.fullTextConversionAttempts ?? 0) + 1},
                  updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
              WHERE id = '${escapeSqlString(article.id)}'
            `)
            await appendArticleReviewServingDeltas(tx, {
              articleId: article.id,
              changedFields: ['fullText', 'fullTextHtml'],
              sourceMutationKey: `ArticleAdminRoutes.convertPdf|article|${article.id}|success|${sourceUpdatedAt.toISOString()}|${getArticleReviewServingMutationValueHash({html, md})}`,
              sourceOperation: 'update',
              sourceUpdatedAt,
            })
          })

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

import {appendArticleReviewServingDeltas} from '../../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {storeUploadedPdf} from './articleAdminRoutesPostUploadPdf/storeUploadedPdf.ts'

export const articleAdminRoutesPostUploadPdf = async ({params, body}: {params: {id: string}; body: {pdf: File}}) => {
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
}

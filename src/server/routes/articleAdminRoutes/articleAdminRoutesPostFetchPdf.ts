import {emptyArticleSourceMetadata, getArticleSourceMetadataValue} from '../../../utils/articleSourceMetadata.ts'
import {fetchPdfForArticle} from '../../cron/fullTextJobs/fetchPdfForArticle.ts'
import {
  appendArticleReviewServingDeltas,
  getArticleReviewServingMutationValueHash,
} from '../../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'

export const articleAdminRoutesPostFetchPdf = async ({params}: {params: {id: string}}) => {
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
}

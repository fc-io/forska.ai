import {appendArticleReviewServingDeltasForIds} from '../../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getTimestampLiteral} from '../../services/appQueryHelpers.ts'

export const articlesRoutesPostPdfFetchReset = () => {
  void getAppDatabaseService()
    .transaction(async (tx) => {
      const sourceUpdatedAt = new Date()
      const whereSql = `full_text_pdf LIKE 'assets/article_pdfs/%'
          AND full_text_source IS NOT NULL
          AND full_text_source != 'user_upload'`
      const articleRows = await tx.queryJson<{articleId: string}>(`
          SELECT id AS articleId
          FROM app.article
          WHERE ${whereSql}
        `)
      const articleIds = articleRows.map((row) => {
        return row.articleId
      })
      await tx.run(
        `
          UPDATE app.article
          SET full_text_fetched_at = NULL,
              full_text_pdf = NULL,
              full_text_source = NULL,
              full_text_original_format = NULL,
              updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
          WHERE ${whereSql}
        `,
      )
      await appendArticleReviewServingDeltasForIds(tx, {
        articleIds,
        changedFields: ['fullTextPDF'],
        sourceMutationKey: `ArticlesRoutes.pdfFetchReset|${sourceUpdatedAt.toISOString()}`,
        sourceOperation: 'update',
        sourceUpdatedAt,
      })
    })
    .then(() => {
      console.log('[pdf-fetch-reset] Reset fetched article PDFs')
    })

  return {success: true, message: 'Reset started in background'}
}

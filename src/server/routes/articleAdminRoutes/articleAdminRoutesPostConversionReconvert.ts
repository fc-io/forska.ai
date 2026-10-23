import {appendArticleReviewServingDeltas} from '../../reviewServing/articleReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {
  assertReconvertCandidate,
  type ReconvertCandidate,
} from './articleAdminRoutesPostConversionReconvert/assertReconvertCandidate.ts'

export const articleAdminRoutesPostConversionReconvert = async ({body}: {body: {articleId: string}}) => {
  return getAppDatabaseService().transaction(async (tx) => {
    const [found] = await tx.queryJson<ReconvertCandidate>(`
          SELECT
            id,
            full_text_pdf AS fullTextPDF,
            full_text_conversion_error AS fullTextConversionError,
            full_text_conversion_status AS fullTextConversionStatus,
            (full_text IS NOT NULL OR full_text_html IS NOT NULL) AS hasConvertedText,
            (full_text IS NOT NULL) AS hasFullText
          FROM app.article
          WHERE id = '${escapeSqlString(body.articleId)}'
          LIMIT 1
        `)
    const article = assertReconvertCandidate(body.articleId, found)
    const sourceUpdatedAt = new Date()

    await tx.run(`
          UPDATE app.article
          SET full_text_conversion_status = NULL,
              full_text_conversion_error = NULL,
              full_text_conversion_attempts = 0,
              full_text_conversion_model_id = NULL,
              full_text_conversion_metadata = NULL,
              full_text = NULL,
              full_text_html = NULL,
              full_text_assets = NULL,
              full_text_canonical_hash = NULL,
              full_text_canonical_version = NULL,
              full_text_figure_mode_built = NULL,
              full_text_char_count = NULL,
              updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
          WHERE id = '${escapeSqlString(article.id)}'
        `)
    await appendArticleReviewServingDeltas(tx, {
      articleId: article.id,
      changedFields: article.hasConvertedText ? ['fullText', 'fullTextHtml'] : [],
      sourceMutationKey: `ArticleAdminRoutes.conversionReconvert|article|${article.id}|${sourceUpdatedAt.toISOString()}`,
      sourceOperation: 'update',
      sourceUpdatedAt,
    })

    return {articleId: article.id, clearedConvertedText: article.hasConvertedText, success: true}
  })
}

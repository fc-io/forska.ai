import {storeConvertedFullText} from '../../fullText/canonicalFullTextStore.ts'
import {
  convertArticlePdf,
  type FullTextConversionRuntimeConfig,
  isPermanentConversionFailure,
} from '../../fullText/converters/fullTextConverter.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../../services/userConfigQueryService.ts'
import {getFailedConversionTargetSetSql} from '../../utils/ensureFullText.ts'

export const articleAdminRoutesPostConvertPdf = async ({params}: {params: {id: string}}) => {
  const {id} = params
  const CONVERSION_TIMEOUT_MS = 600_000
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

    const conversionTarget: {runtimeConfig: FullTextConversionRuntimeConfig | null} = {runtimeConfig: null}

    try {
      const runtimeConfig = await getUserConfigQueryService().getFullTextConversionModelConfig()

      conversionTarget.runtimeConfig = runtimeConfig

      if (!runtimeConfig) {
        throw new Error('No PDF conversion model configured')
      }

      const result = await convertArticlePdf({
        articleId: article.id,
        pdfPath: fullTextPDF,
        runtimeConfig,
        timeoutMs: CONVERSION_TIMEOUT_MS,
      })
      const canonical = await storeConvertedFullText({
        articleId: article.id,
        attempts: (article.fullTextConversionAttempts ?? 0) + 1,
        mutationSource: 'ArticleAdminRoutes.convertPdf',
        result,
        runtimeConfig,
      })

      const duration = Date.now() - startTime
      console.log(`[convertPdf] Success: article ${article.id} (${duration}ms, ${canonical.text.length} chars)`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const isPerm = isPermanentConversionFailure(error)

      const attempts = (article.fullTextConversionAttempts ?? 0) + 1
      const isFinalFailure = isPerm || attempts >= MAX_CONVERSION_ATTEMPTS

      await getAppDatabaseService().run(`
            UPDATE app.article
            SET full_text_conversion_status = ${isFinalFailure ? `'failed'` : 'NULL'},
                full_text_conversion_error = ${getSqlLiteral(errorMessage)},
                ${getFailedConversionTargetSetSql(conversionTarget.runtimeConfig)},
                full_text_conversion_attempts = ${attempts},
                updated_at = current_timestamp
            WHERE id = '${escapeSqlString(article.id)}'
          `)

      console.log(`[convertPdf] ${isFinalFailure ? 'Failed' : 'Retry'}: article ${article.id} - ${errorMessage}`)
    }
  }

  void runConversion()

  return {success: true, message: 'Conversion started', status: 'pending'}
}

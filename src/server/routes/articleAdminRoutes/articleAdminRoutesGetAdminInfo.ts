import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue} from '../../services/appQueryHelpers.ts'

export const articleAdminRoutesGetAdminInfo = async ({params}: {params: {id: string}}) => {
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
}

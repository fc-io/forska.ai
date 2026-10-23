import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'

export const articlesRoutesGetConversionStats = async () => {
  const [[totalFailedRow], lastFailedRows] = await Promise.all([
    getAppDatabaseService().queryJson<{count: number | string}>(`
        SELECT COUNT(*) AS count
        FROM app.article
        WHERE full_text_conversion_status = 'failed'
      `),
    getAppDatabaseService().queryJson<{
      id: string
      articleId: string | null
      title: string
      error: string | null
      attempts: number | null
      converterKind: string | null
      converterVersion: string | null
      optionsHash: string | null
      providerKind: string | null
      modelName: string | null
      canonicalVersion: string | null
      updatedAt: unknown
    }>(`
        SELECT
          id,
          article_id AS articleId,
          article_title AS title,
          full_text_conversion_error AS error,
          full_text_conversion_attempts AS attempts,
          full_text_conversion_metadata->>'converterKind' AS converterKind,
          full_text_conversion_metadata->>'converterVersion' AS converterVersion,
          full_text_conversion_metadata->>'optionsHash' AS optionsHash,
          full_text_conversion_metadata->>'providerKind' AS providerKind,
          full_text_conversion_metadata->>'modelName' AS modelName,
          full_text_canonical_version AS canonicalVersion,
          updated_at AS updatedAt
        FROM app.article
        WHERE full_text_conversion_status = 'failed'
        ORDER BY updated_at DESC
        LIMIT 10
      `),
  ])

  const lastFailed = lastFailedRows.map((row) => {
    return {...row, updatedAt: getDateValue(row.updatedAt)}
  })

  return {lastFailed, totalFailed: Number(totalFailedRow?.count ?? 0)}
}

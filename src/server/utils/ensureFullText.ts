import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {ConversionError, convertPdfToText} from './convertPdfToText.ts'
import {rateLimitedLogger} from './rateLimitedLogger.ts'

const DOCLING_CONVERSION_TIMEOUT_MS = 600_000 // 10 minutes - same as cron job

// In-memory lock map to prevent concurrent conversions of the same article
const conversionLocks = new Map<string, Promise<void>>()

export type EnsureFullTextResult =
  | {text: string; shouldSkip: false} // Success
  | {text: null; shouldSkip: true; reason: 'no_fulltext' | 'conversion_failed'} // Permanently failed or no PDF
  | {text: null; shouldSkip: false; reason: 'transient_failure'} // Transient failure, should requeue

/**
 * Ensure an article has fullText available.
 * If not available, attempt on-the-fly conversion.
 * Uses per-article locking to prevent thundering herd.
 */
export const ensureFullText = async (article: ArticleRecord, articleId: string): Promise<EnsureFullTextResult> => {
  // Fast path: already converted
  if (article.fullText) {
    return {text: article.fullText, shouldSkip: false}
  }

  // No PDF available → permanent skip
  if (!article.fullTextPDF) {
    return {text: null, shouldSkip: true, reason: 'no_fulltext'}
  }

  // Check for prior permanent failure
  if (article.fullTextConversionStatus === 'failed') {
    return {text: null, shouldSkip: true, reason: 'conversion_failed'}
  }

  // Check if another prompt is already converting this article
  const existingLock = conversionLocks.get(articleId)
  if (existingLock) {
    await existingLock // Wait for other conversion to finish
    // Re-fetch article to get result
    const [updated] = await getAppDatabaseService().queryJson<{
      fullText: string | null
      fullTextPDF: string | null
      fullTextConversionStatus: string | null
      fullTextConversionAttempts: number | null
    }>(`
      SELECT
        full_text AS fullText,
        full_text_pdf AS fullTextPDF,
        full_text_conversion_status AS fullTextConversionStatus,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article
      WHERE id = '${escapeSqlString(articleId)}'
      LIMIT 1
    `)
    if (updated?.fullText) {
      return {text: updated.fullText, shouldSkip: false}
    }
    // Check if conversion permanently failed
    if (updated?.fullTextConversionStatus === 'failed') {
      return {text: null, shouldSkip: true, reason: 'conversion_failed'}
    }
    // Transient failure from other conversion
    return {text: null, shouldSkip: false, reason: 'transient_failure'}
  }

  // Acquire lock and convert
  let resolve: () => void = () => {}
  const lock = new Promise<void>((r) => {
    resolve = r
  })
  conversionLocks.set(articleId, lock)

  try {
    // Double-check after acquiring lock (another process may have finished)
    const [fresh] = await getAppDatabaseService().queryJson<{
      fullText: string | null
      fullTextPDF: string | null
      fullTextConversionStatus: string | null
      fullTextConversionAttempts: number | null
    }>(`
      SELECT
        full_text AS fullText,
        full_text_pdf AS fullTextPDF,
        full_text_conversion_status AS fullTextConversionStatus,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article
      WHERE id = '${escapeSqlString(articleId)}'
      LIMIT 1
    `)
    if (fresh?.fullText) {
      return {text: fresh.fullText, shouldSkip: false}
    }

    // Check for prior permanent failure
    if (fresh?.fullTextConversionStatus === 'failed') {
      return {text: null, shouldSkip: true, reason: 'conversion_failed'}
    }

    if (!fresh?.fullTextPDF) {
      return {text: null, shouldSkip: true, reason: 'no_fulltext'}
    }

    console.log(`[ensureFullText] Converting article ${articleId} on-the-fly`)
    const startTime = Date.now()
    const {md, html} = await convertPdfToText(fresh.fullTextPDF, DOCLING_CONVERSION_TIMEOUT_MS)

    await getAppDatabaseService().run(`
      UPDATE app.article
      SET full_text = ${getSqlLiteral(md)},
          full_text_html = ${getSqlLiteral(html)},
          full_text_conversion_status = 'success',
          full_text_conversion_error = NULL,
          full_text_char_count = ${md.length},
          full_text_conversion_attempts = ${(fresh.fullTextConversionAttempts ?? 0) + 1},
          updated_at = current_timestamp
      WHERE id = '${escapeSqlString(articleId)}'
    `)

    console.log(`[ensureFullText] Success: article ${articleId} (${Date.now() - startTime}ms, ${md.length} chars)`)
    return {text: md, shouldSkip: false}
  } catch (error) {
    // Classify error
    const errorMessage = error instanceof Error ? error.message : String(error)
    const msg = errorMessage.toLowerCase()

    // Permanent errors
    const isPerm =
      (error instanceof ConversionError && error.isPermanent)
      || msg.includes('encrypted')
      || msg.includes('password')
      || msg.includes('invalid pdf')
      || msg.includes('file not found')

    // Get current attempts
    const [current] = await getAppDatabaseService().queryJson<{attempts: number | null}>(`
      SELECT full_text_conversion_attempts AS attempts
      FROM app.article
      WHERE id = '${escapeSqlString(articleId)}'
      LIMIT 1
    `)
    const attempts = (current?.attempts ?? 0) + 1
    const maxRetries = 3

    // If permanent OR max retries exceeded → 'failed'
    const isFinalFailure = isPerm || attempts >= maxRetries

    await getAppDatabaseService().run(`
      UPDATE app.article
      SET full_text_conversion_status = ${isFinalFailure ? `'failed'` : 'NULL'},
          full_text_conversion_error = ${getSqlLiteral(errorMessage)},
          full_text_conversion_attempts = ${attempts},
          updated_at = current_timestamp
      WHERE id = '${escapeSqlString(articleId)}'
    `)

    rateLimitedLogger.log(
      `fulltext:conversion:${isFinalFailure ? 'failed' : 'retry'}`,
      `[ensureFullText] ${isFinalFailure ? 'Failed' : 'Retry'}: article ${articleId} - ${errorMessage}`,
    )

    // Return status to indicate whether caller should skip or requeue
    if (isFinalFailure) {
      return {text: null, shouldSkip: true, reason: 'conversion_failed'}
    }
    return {text: null, shouldSkip: false, reason: 'transient_failure'}
  } finally {
    conversionLocks.delete(articleId)
    resolve()
  }
}

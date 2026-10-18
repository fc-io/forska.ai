import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {storeConvertedFullText} from '../fullText/canonicalFullTextStore.ts'
import {
  convertArticlePdf,
  type FullTextConversionRuntimeConfig,
  getFullTextConversionFailureMetadata,
  isPermanentConversionFailure,
} from '../fullText/converters/fullTextConverter.ts'
import {getJsonSqlLiteral} from '../providers/providerDbUtils.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'

const CONVERSION_TIMEOUT_MS = 600_000 // 10 minutes - same as cron job
const ensureFullTextLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const ensureFullTextWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const ensureFullTextComponent = 'ensureFullText'
const ensureFullTextWorkloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'fullText.ensure',
  workloadClass: 'background.fullText.ensure',
}

// In-memory lock map to prevent concurrent conversions of the same article
const conversionLocks = new Map<string, Promise<void>>()

export type EnsureFullTextResult =
  | {text: string; shouldSkip: false} // Success
  | {text: null; shouldSkip: true; reason: 'no_fulltext' | 'conversion_failed'} // Permanently failed or no PDF
  | {text: null; shouldSkip: false; reason: 'transient_failure'} // Transient failure, should requeue

export const getFailedConversionTargetSetSql = (runtimeConfig: FullTextConversionRuntimeConfig | null): string => {
  return [
    `full_text_conversion_model_id = ${getSqlLiteral(runtimeConfig?.modelId ?? null)}`,
    `full_text_conversion_metadata = ${
      runtimeConfig ? getJsonSqlLiteral(getFullTextConversionFailureMetadata(runtimeConfig)) : 'NULL'
    }`,
  ].join(',\n')
}

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
    const [updated] = await getAppDatabaseService().queryJsonBackground<{
      fullText: string | null
      fullTextPDF: string | null
      fullTextConversionStatus: string | null
      fullTextConversionAttempts: number | null
    }>(
      `
      SELECT
        full_text AS fullText,
        full_text_pdf AS fullTextPDF,
        full_text_conversion_status AS fullTextConversionStatus,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article
      WHERE id = '${escapeSqlString(articleId)}'
      LIMIT 1
    `,
      {...ensureFullTextWorkloadContext, maxResultRows: 1},
    )
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
  const conversionStartedAt = Date.now()
  const conversionTarget: {runtimeConfig: FullTextConversionRuntimeConfig | null} = {runtimeConfig: null}

  try {
    // Double-check after acquiring lock (another process may have finished)
    const [fresh] = await getAppDatabaseService().queryJsonBackground<{
      fullText: string | null
      fullTextPDF: string | null
      fullTextConversionStatus: string | null
      fullTextConversionAttempts: number | null
    }>(
      `
      SELECT
        full_text AS fullText,
        full_text_pdf AS fullTextPDF,
        full_text_conversion_status AS fullTextConversionStatus,
        full_text_conversion_attempts AS fullTextConversionAttempts
      FROM app.article
      WHERE id = '${escapeSqlString(articleId)}'
      LIMIT 1
    `,
      {...ensureFullTextWorkloadContext, maxResultRows: 1},
    )
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

    ensureFullTextLogger.log('ensureFullText:conversionStarted', '[ensureFullText] On-demand conversion started', {
      articleId,
      component: ensureFullTextComponent,
    })
    const runtimeConfig = await getUserConfigQueryService().getFullTextConversionModelConfig()

    conversionTarget.runtimeConfig = runtimeConfig

    if (!runtimeConfig) {
      throw new Error('No PDF conversion model configured')
    }

    const result = await convertArticlePdf({
      articleId,
      pdfPath: fresh.fullTextPDF,
      runtimeConfig,
      timeoutMs: CONVERSION_TIMEOUT_MS,
    })
    const canonical = await storeConvertedFullText({
      articleId,
      attempts: (fresh.fullTextConversionAttempts ?? 0) + 1,
      mutationSource: 'ensureFullText',
      result,
      runtimeConfig,
      workloadContext: ensureFullTextWorkloadContext,
    })

    ensureFullTextLogger.log('ensureFullText:conversionSucceeded', '[ensureFullText] On-demand conversion succeeded', {
      articleId,
      canonicalHash: canonical.hash,
      charCount: canonical.text.length,
      component: ensureFullTextComponent,
      durationMs: Date.now() - conversionStartedAt,
    })
    return {text: canonical.text, shouldSkip: false}
  } catch (error) {
    // Classify error
    const errorMessage = error instanceof Error ? error.message : String(error)
    const isPerm = isPermanentConversionFailure(error)

    // Get current attempts
    const [current] = await getAppDatabaseService().queryJsonBackground<{attempts: number | null}>(
      `
      SELECT full_text_conversion_attempts AS attempts
      FROM app.article
      WHERE id = '${escapeSqlString(articleId)}'
      LIMIT 1
    `,
      {...ensureFullTextWorkloadContext, maxResultRows: 1},
    )
    const attempts = (current?.attempts ?? 0) + 1
    const maxRetries = 3

    // If permanent OR max retries exceeded → 'failed'
    const isFinalFailure = isPerm || attempts >= maxRetries

    await getAppDatabaseService().runBackground(
      `
      UPDATE app.article
      SET full_text_conversion_status = ${isFinalFailure ? `'failed'` : 'NULL'},
          full_text_conversion_error = ${getSqlLiteral(errorMessage)},
          ${getFailedConversionTargetSetSql(conversionTarget.runtimeConfig)},
          full_text_conversion_attempts = ${attempts},
          updated_at = current_timestamp
      WHERE id = '${escapeSqlString(articleId)}'
    `,
      ensureFullTextWorkloadContext,
    )

    ensureFullTextWarningLogger.warn(
      `fulltext:conversion:${isFinalFailure ? 'failed' : 'retry'}`,
      `[ensureFullText] On-demand conversion ${isFinalFailure ? 'failed' : 'will retry'}`,
      {
        articleId,
        attempts,
        component: ensureFullTextComponent,
        durationMs: Date.now() - conversionStartedAt,
        errorMessage,
        finalFailure: isFinalFailure,
      },
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

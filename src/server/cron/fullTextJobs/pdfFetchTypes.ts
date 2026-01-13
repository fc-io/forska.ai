/**
 * Structured result from a PDF fetch source.
 * Each fetcher returns this structure to provide granular feedback.
 */
export type PdfFetchAttemptResult = {
  source: string
  tried: boolean
  success: boolean
  result?: {fullTextPDF: string; fullTextSource: string; fullTextOriginalFormat: string}
  reason?: string // Why it wasn't tried, or why it failed
  details?: string // Additional info (e.g., API response status)
}

/**
 * Legacy result format for backward compatibility with cron job.
 */
export type PdfFetchLegacyResult = {
  fullTextPDF: string | null
  fullTextSource: string | null
  fullTextOriginalFormat: string | null
}

/**
 * Full result from fetching PDFs, including all attempts.
 */
export type PdfFetchFullResult = {attempts: PdfFetchAttemptResult[]; finalResult: PdfFetchLegacyResult}

/**
 * Convert a list of attempts to the legacy result format.
 * Returns the first successful result, or a null result if none succeeded.
 */
export const attemptsToLegacyResult = (attempts: PdfFetchAttemptResult[]): PdfFetchLegacyResult => {
  const successfulAttempt = attempts.find((a) => {
    return a.success && a.result
  })

  if (successfulAttempt?.result) {
    return {
      fullTextPDF: successfulAttempt.result.fullTextPDF,
      fullTextSource: successfulAttempt.result.fullTextSource,
      fullTextOriginalFormat: successfulAttempt.result.fullTextOriginalFormat,
    }
  }

  return {fullTextPDF: null, fullTextSource: null, fullTextOriginalFormat: null}
}

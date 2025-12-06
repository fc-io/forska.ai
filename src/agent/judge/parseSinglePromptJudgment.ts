import {type as arktype} from 'arktype'

/**
 * Schema for single-prompt LLM responses.
 * The response has simple, standardized keys since there's only one question.
 * The 'answer' field accepts both strings and string arrays to support
 * prompts with array output_types (e.g., specialty classification).
 */
const SinglePromptResponseSchema = arktype({
  answer: 'string | string[]',
  explanation: 'string',
  quotes: 'string[] | null',
})

export type SinglePromptJudgmentResult = {answer: string | string[]; explanation: string; quotes: string[] | null}

/**
 * Sanitizes a JSON string by escaping invalid escape sequences.
 * In JSON, only these escape sequences are valid: \" \\ \/ \b \f \n \r \t \uXXXX
 * This function converts any \x (where x is not a valid escape char) to \\x,
 * making it a literal backslash. This is useful for LLM responses that contain
 * LaTeX (e.g., \varepsilon) which produces invalid escape sequences like \v.
 */
export const sanitizeJsonEscapes = (rawJson: string): string => {
  // Match backslash followed by a character that's NOT a valid JSON escape
  // Valid JSON escapes: " \ / b f n r t u
  return rawJson.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
}

/**
 * Result of attempting to parse JSON with sanitization fallback.
 */
export type ParseAttemptResult =
  | {success: true; data: unknown; sanitizationUsed: boolean}
  | {success: false; originalError: string; sanitizationAttempted: boolean; sanitizedError: string | null}

/**
 * Attempts to parse JSON, falling back to sanitization if needed.
 * Returns detailed info about what was attempted for error tracking.
 */
export const tryParseJsonWithSanitization = (response: string): ParseAttemptResult => {
  // First, try normal JSON parsing
  try {
    const data: unknown = JSON.parse(response)
    return {success: true, data, sanitizationUsed: false}
  } catch (originalErr) {
    const originalError = originalErr instanceof Error ? originalErr.message : String(originalErr)

    // Try sanitizing invalid escape sequences
    try {
      const sanitized = sanitizeJsonEscapes(response)
      const data: unknown = JSON.parse(sanitized)
      console.log('JSON parse succeeded after sanitizing invalid escape sequences')
      return {success: true, data, sanitizationUsed: true}
    } catch (sanitizedErr) {
      const sanitizedError = sanitizedErr instanceof Error ? sanitizedErr.message : String(sanitizedErr)
      // Return info about both errors
      return {
        success: false,
        originalError,
        sanitizationAttempted: true,
        sanitizedError: sanitizedError !== originalError ? sanitizedError : null,
      }
    }
  }
}

/**
 * Parses and validates a single-prompt response from the LLM.
 * Much simpler than the multi-prompt parser since we use standardized keys.
 *
 * Attempts normal JSON parsing first. If that fails (e.g., due to invalid
 * escape sequences from LaTeX like \varepsilon), it sanitizes the JSON
 * and retries. If sanitization also fails, the original error is thrown.
 */
export const parseSinglePromptJudgment = (response: string): SinglePromptJudgmentResult => {
  const parseResult = tryParseJsonWithSanitization(response)

  if (!parseResult.success) {
    // Throw original error for retry messaging
    throw new Error(parseResult.originalError)
  }

  SinglePromptResponseSchema.assert(parseResult.data)
  return parseResult.data as SinglePromptJudgmentResult
}

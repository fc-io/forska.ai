import {type as arktype} from 'arktype'

export type SinglePromptJudgmentResult = {answer: string | string[]; explanation: string; quotes: string[] | null}

/**
 * Builds an arktype schema for single-prompt LLM responses.
 * The 'answer' field type is determined by the prompt's type definition.
 * If no type is specified, falls back to 'string | string[]' for flexibility.
 */
const buildSinglePromptResponseSchema = (promptType: string | null) => {
  // Use the prompt type if provided, otherwise fall back to flexible string/array
  const answerType = promptType && promptType.trim() ? promptType : 'string | string[]'

  // Use record-based definition with type casting for dynamic types
  const typeDefs: Record<string, string> = {answer: answerType, explanation: 'string', quotes: 'string[] | null'}

  return arktype(typeDefs)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const isEmptyOuterExplanation = (value: unknown): boolean => {
  return value === undefined || (typeof value === 'string' && value.trim().length === 0)
}

const isEmptyOuterQuotes = (value: unknown): boolean => {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0)
}

const parseNestedAnswerObject = (answer: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(answer)

    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const hasSinglePromptJudgmentKeys = (value: Record<string, unknown>): boolean => {
  return 'answer' in value && 'explanation' in value && 'quotes' in value
}

const getRecoveredNestedAnswerData = (
  data: unknown,
  schema: ReturnType<typeof buildSinglePromptResponseSchema>,
): unknown => {
  if (!isRecord(data) || typeof data.answer !== 'string') {
    return data
  }

  if (!isEmptyOuterExplanation(data.explanation) || !isEmptyOuterQuotes(data.quotes)) {
    return data
  }

  const nestedAnswer = parseNestedAnswerObject(data.answer)

  return nestedAnswer && hasSinglePromptJudgmentKeys(nestedAnswer) && schema.allows(nestedAnswer) ? nestedAnswer : data
}

/**
 * Sanitizes a JSON string by escaping invalid escape sequences.
 * In JSON, only these escape sequences are valid: \" \\ \/ \b \f \n \r \t \uXXXX
 * This function converts any \x (where x is not a valid escape char) to \\x,
 * making it a literal backslash. This is useful for LLM responses that contain
 * LaTeX (e.g., \log, \cdot, \varepsilon) which produces invalid escape sequences.
 *
 * Uses a single-pass character-by-character approach to avoid over-escaping.
 */
export const sanitizeJsonEscapes = (rawJson: string): string => {
  const validEscapeChars = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])
  const result: string[] = []
  let i = 0

  while (i < rawJson.length) {
    const char = rawJson.charAt(i)

    if (char === '\\' && i + 1 < rawJson.length) {
      const nextChar = rawJson.charAt(i + 1)

      if (nextChar === '\\') {
        // Already escaped backslash (\\), copy both and skip ahead
        result.push('\\\\')
        i += 2
      } else if (validEscapeChars.has(nextChar)) {
        // Valid escape sequence, copy as-is
        result.push('\\')
        result.push(nextChar)
        i += 2
      } else {
        // Invalid escape sequence like \l, \c, \v - escape the backslash
        result.push('\\\\')
        result.push(nextChar)
        i += 2
      }
    } else {
      // Regular character
      result.push(char)
      i += 1
    }
  }

  return result.join('')
}

/**
 * Result of attempting to parse JSON with sanitization fallback.
 */
export type ParseAttemptResult =
  | {success: true; data: unknown; sanitizationUsed: boolean; sanitizedResponse: string | null}
  | {
      success: false
      originalError: string
      sanitizationAttempted: boolean
      sanitizedError: string | null
      sanitizedResponse: string | null
    }

const getLikelyJsonPayload = (response: string): string | null => {
  const fencedMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const fencedPayload = fencedMatch?.[1]?.trim() ?? ''

  if (fencedPayload.startsWith('{') || fencedPayload.startsWith('[')) {
    return fencedPayload
  }

  const objectStart = response.indexOf('{')
  const arrayStart = response.indexOf('[')
  const candidateStart = [objectStart, arrayStart]
    .filter((index) => {
      return index >= 0
    })
    .sort((left, right) => {
      return left - right
    })[0]

  if (candidateStart === undefined) {
    return null
  }

  const candidate = response.slice(candidateStart).trim()
  const objectEnd = candidate.lastIndexOf('}')
  const arrayEnd = candidate.lastIndexOf(']')
  const candidateEnd = Math.max(objectEnd, arrayEnd)

  return candidateEnd >= 0 ? candidate.slice(0, candidateEnd + 1) : null
}

/**
 * Attempts to parse JSON, falling back to sanitization if needed.
 * Returns detailed info about what was attempted for error tracking.
 */
export const tryParseJsonWithSanitization = (response: string): ParseAttemptResult => {
  // First, try normal JSON parsing
  try {
    const data: unknown = JSON.parse(response)
    return {success: true, data, sanitizationUsed: false, sanitizedResponse: null}
  } catch (originalErr) {
    const originalError = originalErr instanceof Error ? originalErr.message : String(originalErr)
    const extractedPayload = getLikelyJsonPayload(response)

    if (extractedPayload !== null && extractedPayload !== response) {
      const extractedParseResult = tryParseJsonWithSanitization(extractedPayload)

      if (extractedParseResult.success) {
        return {
          data: extractedParseResult.data,
          sanitizedResponse: extractedPayload,
          sanitizationUsed: true,
          success: true,
        }
      }
    }

    // Try sanitizing invalid escape sequences
    const sanitized = sanitizeJsonEscapes(response)
    try {
      const data: unknown = JSON.parse(sanitized)
      console.log('JSON parse succeeded after sanitizing invalid escape sequences')
      return {success: true, data, sanitizationUsed: true, sanitizedResponse: sanitized}
    } catch (sanitizedErr) {
      const sanitizedError = sanitizedErr instanceof Error ? sanitizedErr.message : String(sanitizedErr)
      // Return info about both errors and the sanitized response for debugging
      return {
        success: false,
        originalError,
        sanitizationAttempted: true,
        sanitizedError: sanitizedError !== originalError ? sanitizedError : null,
        sanitizedResponse: sanitized !== response ? sanitized : null,
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
 *
 * @param response - The raw LLM response string
 * @param promptType - The expected type for the answer (e.g., "'yes' | 'no' | 'unsure'")
 */
export const parseSinglePromptJudgment = (response: string, promptType: string | null): SinglePromptJudgmentResult => {
  const parseResult = tryParseJsonWithSanitization(response)

  if (!parseResult.success) {
    // Throw original error for retry messaging
    throw new Error(parseResult.originalError)
  }

  const schema = buildSinglePromptResponseSchema(promptType)
  const data = getRecoveredNestedAnswerData(parseResult.data, schema)
  schema.assert(data)
  return data as SinglePromptJudgmentResult
}

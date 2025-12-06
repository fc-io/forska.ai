import {type as arktype} from 'arktype'

import {remapFuzzyKeys} from './fuzzyKeyMatcher.ts'
import {getBaseHeading, getShortIdForPrompt, type PromptForJudging, type ShortIdMapping} from './judgeGetPrompt.ts'

type JudgmentFlag = 'yes' | 'no' | 'unsure' | 'undecided' | string
export type JudgmentResultType = {
  article_judged_as_ai?: JudgmentFlag
  article_judged_as_ai_agent?: JudgmentFlag
  article_judged_as_healthcare?: JudgmentFlag
  [key: string]: unknown
}

/**
 * Sanitizes a JSON string by escaping invalid escape sequences.
 * In JSON, only these escape sequences are valid: \" \\ \/ \b \f \n \r \t \uXXXX
 * This function converts any \x (where x is not a valid escape char) to \\x,
 * making it a literal backslash. This is useful for LLM responses that contain
 * LaTeX (e.g., \varepsilon) which produces invalid escape sequences like \v.
 */
const sanitizeJsonEscapes = (rawJson: string): string => {
  // Match backslash followed by a character that's NOT a valid JSON escape
  // Valid JSON escapes: " \ / b f n r t u
  return rawJson.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
}

/**
 * Parses and validates the model response against the expected schema.
 * Uses fuzzy matching to correct near-miss transcription errors in keys.
 *
 * Attempts normal JSON parsing first. If that fails (e.g., due to invalid
 * escape sequences from LaTeX like \varepsilon), it sanitizes the JSON
 * and retries. If sanitization also fails, the original error is thrown.
 */
export const parseJudgment = (
  response: string,
  prompts: PromptForJudging,
  shortIdMapping: ShortIdMapping,
): JudgmentResultType => {
  let rawParsed: unknown

  // First, try normal JSON parsing
  try {
    rawParsed = JSON.parse(response)
  } catch (originalError) {
    // If normal parsing fails, try sanitizing invalid escape sequences
    try {
      const sanitized = sanitizeJsonEscapes(response)
      rawParsed = JSON.parse(sanitized)
      console.log('JSON parse succeeded after sanitizing invalid escape sequences')
    } catch {
      // If sanitization also fails, throw the original error for proper retry messaging
      throw originalError
    }
  }

  // Build expected keys list for fuzzy matching
  const expectedKeys: string[] = []
  const typeDefs: Record<string, string> = {}

  for (const prompt of prompts) {
    const shortId = getShortIdForPrompt(prompt.id, shortIdMapping)
    const baseHeading = getBaseHeading(prompt, shortId)
    const keyQuestion = `${baseHeading}---question`
    const keyExplanation = `${baseHeading}---explanation`
    const keyQuotes = `${baseHeading}---quotes`

    expectedKeys.push(keyQuestion, keyExplanation, keyQuotes)
    typeDefs[keyQuestion] = prompt.type || 'string'
    typeDefs[keyExplanation] = 'string'
    typeDefs[keyQuotes] = 'string[] | null'
  }

  // Apply fuzzy matching to correct near-miss keys
  const parsed = remapFuzzyKeys(rawParsed as Record<string, unknown>, expectedKeys)

  // Validate with arktype
  const Types = arktype(typeDefs)
  Types.assert(parsed)

  return parsed
}

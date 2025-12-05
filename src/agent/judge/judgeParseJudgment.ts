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
 * Parses and validates the model response against the expected schema.
 * Uses fuzzy matching to correct near-miss transcription errors in keys.
 */
export const parseJudgment = (
  response: string,
  prompts: PromptForJudging,
  shortIdMapping: ShortIdMapping,
): JudgmentResultType => {
  const rawParsed: unknown = JSON.parse(response)

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

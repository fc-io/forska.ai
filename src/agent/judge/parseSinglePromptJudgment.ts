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
 * Parses and validates a single-prompt response from the LLM.
 * Much simpler than the multi-prompt parser since we use standardized keys.
 */
export const parseSinglePromptJudgment = (response: string): SinglePromptJudgmentResult => {
  const parsed: unknown = JSON.parse(response)
  SinglePromptResponseSchema.assert(parsed)
  return parsed as SinglePromptJudgmentResult
}

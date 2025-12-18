/**
 * Retrieves filter options for prompts using the enum-based strategy.
 *
 * This strategy parses the prompt's arktype `type` field to extract
 * the possible enum values, without querying the database for actual answers.
 *
 * This is used when the prompt type only contains enum values
 * (e.g., `'yes' | 'no' | 'unsure'`).
 */

import type {PromptFilterInfo} from './articlesReviewsFiltersUtils.ts'

export type EnumFilterResult = {promptId: string; promptName: string; answeredOriginalValues: string[]}

/**
 * Get filter options from enum-based prompts.
 * Returns the parsed enum values as filter options.
 */
export const getEnumBasedFilters = (prompts: PromptFilterInfo[]): EnumFilterResult[] => {
  return prompts
    .filter((p) => {
      return p.strategy === 'enum' && p.enumOptions !== null
    })
    .map((p) => {
      return {promptId: p.promptId, promptName: p.promptName, answeredOriginalValues: p.enumOptions ?? []}
    })
}

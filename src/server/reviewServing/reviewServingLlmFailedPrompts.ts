// Every review list mode reads llm_failed_prompt_count (NOT NULL DEFAULT 0) and llm_failed_prompt_codes from the
// article serving state, so a missing or malformed count means the read projected the wrong columns. Fail loudly
// instead of hiding failed prompts. The codes are NULL when no prompt failed.
export const getReviewServingLlmFailedPrompts = (input: {
  articleId: string
  contractKey: string
  row: {llm_failed_prompt_codes?: unknown; llm_failed_prompt_count?: unknown}
}): {llmFailedPromptCodes: string | null; llmFailedPromptCount: number} => {
  const count = input.row.llm_failed_prompt_count
  const codes = input.row.llm_failed_prompt_codes ?? null

  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error(`${input.contractKey} returned no valid llm_failed_prompt_count for article ${input.articleId}`)
  }

  if (codes !== null && typeof codes !== 'string') {
    throw new Error(`${input.contractKey} returned a malformed llm_failed_prompt_codes for article ${input.articleId}`)
  }

  return {llmFailedPromptCodes: count === 0 ? null : codes, llmFailedPromptCount: count}
}

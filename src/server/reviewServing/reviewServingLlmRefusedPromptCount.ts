// Every review list mode reads llm_refused_prompt_count from the article serving state (NOT NULL DEFAULT 0), so a
// missing or malformed value means the read projected the wrong columns. Fail loudly instead of hiding refusals.
export const getReviewServingLlmRefusedPromptCount = (input: {
  articleId: string
  contractKey: string
  row: {llm_refused_prompt_count?: unknown}
}) => {
  const count = input.row.llm_refused_prompt_count

  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error(`${input.contractKey} returned no valid llm_refused_prompt_count for article ${input.articleId}`)
  }

  return count
}

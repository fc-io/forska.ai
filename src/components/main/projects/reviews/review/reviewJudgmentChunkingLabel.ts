export const getReviewJudgmentChunkingLabel = (judgment: {
  chunkCount?: number | null
  chunkPlanHash?: string | null
  chunkingStrategy?: string | null
  fullTextMode?: string | null
}): string => {
  const strategy = String(judgment.chunkingStrategy ?? '').trim()

  return judgment.fullTextMode === 'chunked'
    ? `yes (full text in ${judgment.chunkCount ?? '?'} parts, plan ${String(judgment.chunkPlanHash ?? '').slice(0, 8)})`
    : judgment.fullTextMode === 'single'
      ? 'no (full text in one request)'
      : strategy.length > 0
        ? `yes (${strategy})`
        : 'no'
}

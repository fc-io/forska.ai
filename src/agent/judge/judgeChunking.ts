const CHARS_PER_TOKEN = 4

export type JudgmentChunkingStrategy = 'patient_h3_greedy' | 'article_heading_greedy' | 'article_paragraph_greedy'

export const getApproxTokens = (text: string): number => {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export const getApproxTokensForPrompts = (systemPrompt: string, userPrompt: string): number => {
  return Math.ceil((systemPrompt.length + userPrompt.length) / CHARS_PER_TOKEN)
}

export const isWithinContextBudget = ({
  systemPrompt,
  userPrompt,
  modelContext,
  maxCompletionTokens,
}: {
  systemPrompt: string
  userPrompt: string
  modelContext: number
  maxCompletionTokens: number
}): {withinBudget: boolean; approxPromptTokens: number; approxTotalTokens: number} => {
  const approxPromptTokens = getApproxTokensForPrompts(systemPrompt, userPrompt)
  const approxTotalTokens = approxPromptTokens + maxCompletionTokens
  return {withinBudget: approxTotalTokens <= modelContext, approxPromptTokens, approxTotalTokens}
}

const splitParagraphBuckets = (text: string): string[] => {
  const parts = text.split(/(\n\s*\n+)/g)

  const pair = (index: number): string[] => {
    const a = parts[index] ?? ''
    const b = parts[index + 1] ?? ''
    return index >= parts.length ? [] : index >= parts.length - 1 ? [a] : [a + b, ...pair(index + 2)]
  }

  return pair(0)
}

const packBucketsGreedy = (buckets: string[], maxChunkChars: number): string[] => {
  const chunks: string[] = []
  const last = buckets.reduce((current, bucket) => {
    const next = current.length === 0 ? bucket : current + bucket
    const shouldSplit = current.length > 0 && next.length > maxChunkChars
    return shouldSplit ? (chunks.push(current), bucket) : next
  }, '')

  const withLast = last.length > 0 ? [...chunks, last] : chunks
  return withLast.length > 0 ? withLast : ['']
}

const packPatientBucketsGreedy = (prefix: string, buckets: string[], maxChunkChars: number): string[] => {
  const chunks: string[] = []
  const last = buckets.reduce((current, bucket) => {
    const next = current + bucket
    const shouldSplit = current !== prefix && next.length > maxChunkChars
    return shouldSplit ? (chunks.push(current), prefix + bucket) : next
  }, prefix)

  return buckets.length === 0 ? [prefix] : [...chunks, last]
}

export const chunkPatientMarkdown = ({
  markdown,
  maxChunkChars,
}: {
  markdown: string
  maxChunkChars: number
}): {chunks: string[]; strategy: JudgmentChunkingStrategy} => {
  const parts = markdown.split(/(?=^### )/m)
  const prefix = parts[0] ?? ''
  const buckets = parts.slice(1)

  const chunks = packPatientBucketsGreedy(prefix, buckets, maxChunkChars)
  return {chunks, strategy: 'patient_h3_greedy'}
}

export const chunkArticleText = ({
  text,
  maxChunkChars,
}: {
  text: string
  maxChunkChars: number
}): {chunks: string[]; strategy: JudgmentChunkingStrategy} => {
  const hasHeading = /^#{1,6} /m.test(text)
  const buckets = hasHeading ? text.split(/(?=^#{1,6} )/m) : splitParagraphBuckets(text)
  const nonEmptyBuckets = buckets[0] === '' ? buckets.slice(1) : buckets
  const chunks = packBucketsGreedy(nonEmptyBuckets, maxChunkChars)
  return {chunks, strategy: hasHeading ? 'article_heading_greedy' : 'article_paragraph_greedy'}
}

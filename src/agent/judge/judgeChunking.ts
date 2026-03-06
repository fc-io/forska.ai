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

const splitTextByMaxChars = (text: string, maxChunkChars: number): string[] => {
  if (maxChunkChars <= 0) return ['']
  if (text.length <= maxChunkChars) return [text]

  const head = text.slice(0, maxChunkChars)
  const tail = text.slice(maxChunkChars)
  return [head, ...splitTextByMaxChars(tail, maxChunkChars)]
}

const splitBucketPlain = (bucket: string, maxChunkChars: number): string[] => {
  if (bucket.length <= maxChunkChars) return [bucket]

  const segments = splitParagraphBuckets(bucket)
  const boundedSegments = segments.flatMap((segment) => {
    return segment.length <= maxChunkChars ? [segment] : splitTextByMaxChars(segment, maxChunkChars)
  })

  return boundedSegments.length === 0 ? [''] : boundedSegments
}

const splitBucketPreservingFirstLine = (bucket: string, maxChunkChars: number): string[] => {
  if (bucket.length <= maxChunkChars) return [bucket]

  const newlineIndex = bucket.indexOf('\n')
  const header = newlineIndex === -1 ? bucket : bucket.slice(0, newlineIndex + 1)
  const rest = newlineIndex === -1 ? '' : bucket.slice(newlineIndex + 1)

  const perPieceMax = maxChunkChars - header.length
  if (perPieceMax <= 0) {
    return splitTextByMaxChars(bucket, maxChunkChars)
  }

  const segments = splitParagraphBuckets(rest)
  const boundedSegments = segments.flatMap((segment) => {
    return segment.length <= perPieceMax ? [segment] : splitTextByMaxChars(segment, perPieceMax)
  })

  const packed = packBucketsGreedy(boundedSegments.length === 0 ? [''] : boundedSegments, perPieceMax)
  return packed.map((chunk) => {
    return header + chunk
  })
}

const splitBucketToMaxSize = (bucket: string, maxChunkChars: number): string[] => {
  if (bucket.length <= maxChunkChars) return [bucket]
  const startsWithHeading = /^#{1,6} /.test(bucket)
  return startsWithHeading
    ? splitBucketPreservingFirstLine(bucket, maxChunkChars)
    : splitBucketPlain(bucket, maxChunkChars)
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

  if (prefix.length >= maxChunkChars) {
    const truncated = maxChunkChars > 0 ? prefix.slice(0, maxChunkChars) : ''
    return {chunks: [truncated], strategy: 'patient_h3_greedy'}
  }

  const maxBucketChars = Math.max(0, maxChunkChars - prefix.length)
  if (maxBucketChars === 0) {
    return {chunks: [prefix], strategy: 'patient_h3_greedy'}
  }

  const safeBuckets = buckets.flatMap((bucket) => {
    return splitBucketPreservingFirstLine(bucket, maxBucketChars)
  })

  const chunks = packPatientBucketsGreedy(prefix, safeBuckets, maxChunkChars)
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

  const safeBuckets = nonEmptyBuckets.flatMap((bucket) => {
    return splitBucketToMaxSize(bucket, maxChunkChars)
  })
  const chunks = packBucketsGreedy(safeBuckets, maxChunkChars)
  return {chunks, strategy: hasHeading ? 'article_heading_greedy' : 'article_paragraph_greedy'}
}

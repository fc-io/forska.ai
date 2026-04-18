import {describe, expect, test} from 'bun:test'

import {chunkArticleText, chunkPatientMarkdown, isWithinContextBudget} from './judgeChunking.ts'

describe('chunkPatientMarkdown', () => {
  test('repeats prefix; does not split buckets; respects max chars', () => {
    const markdown = `# id: fhir:patient123

## Patient

name: Jane Doe

## Timeline
### 2024-01-01
bp: 120/80

### 2024-01-02
bp: 130/85

### 2024-01-03
bp: 110/70
`

    const parts = markdown.split(/(?=^### )/m)
    const prefix = parts[0] ?? ''
    const buckets = parts.slice(1)

    const bucket1 = buckets[0] ?? ''
    const bucket2 = buckets[1] ?? ''
    const maxChunkChars = prefix.length + bucket1.length + bucket2.length
    const result = chunkPatientMarkdown({markdown, maxChunkChars})

    expect(result.strategy).toBe('patient_h3_greedy')
    expect(result.chunks.length).toBe(2)

    result.chunks.forEach((chunk) => {
      expect(chunk.startsWith(prefix)).toBe(true)
      expect(chunk.length).toBeLessThanOrEqual(maxChunkChars)
    })

    buckets.forEach((bucket) => {
      const hits = result.chunks.filter((chunk) => {
        return chunk.includes(bucket)
      })
      expect(hits.length).toBe(1)
    })
  })
})

describe('chunkArticleText', () => {
  test('chunks by headings when headings exist', () => {
    const text = `Preamble line that is not a heading.

## Introduction

Intro paragraph.

## Methods

Methods paragraph.

## Results

Results paragraph.
`

    const maxChunkChars = text.length - 10
    const result = chunkArticleText({text, maxChunkChars})

    expect(result.strategy).toBe('article_heading_greedy')
    expect(result.chunks.join('')).toBe(text)
    result.chunks.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(maxChunkChars)
    })
  })

  test('chunks by paragraphs when no headings exist', () => {
    const text = `First paragraph.

Second paragraph.

Third paragraph.
`

    const maxChunkChars = 'First paragraph.\n\nSecond paragraph.\n\n'.length
    const result = chunkArticleText({text, maxChunkChars})

    expect(result.strategy).toBe('article_paragraph_greedy')
    expect(result.chunks.join('')).toBe(text)
    result.chunks.forEach((chunk) => {
      expect(chunk.length).toBeLessThanOrEqual(maxChunkChars)
    })
  })

  test('uses prompt-token budget while still reporting approximate total tokens', () => {
    const systemPrompt = 's'.repeat(4000)
    const userPrompt = 'u'.repeat(4000)
    const result = isWithinContextBudget({systemPrompt, userPrompt, modelContext: 2000, maxCompletionTokens: 4000})

    expect(result.withinBudget).toBe(true)
    expect(result.approxPromptTokens).toBe(2000)
    expect(result.approxTotalTokens).toBe(6000)
  })
})

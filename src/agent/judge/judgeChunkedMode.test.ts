import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getChunkParallelLimit, getFullTextCallMode, MAX_COMPLETION_TOKENS} from '../judge.ts'
import {getFullTextChunkJudgingUserPrompt} from './judgeGetPrompt.ts'
import {parseFullTextChunkJudgment, parseSinglePromptJudgment} from './parseSinglePromptJudgment.ts'

test('chunked mode schemas: part judgment with confidence + merge in the normal schema', () => {
  const part = parseFullTextChunkJudgment(
    JSON.stringify({answer: 'yes', confidence: 0.75, explanation: 'Randomised.', quotes: ['verbatim quote']}),
    `'yes' | 'no'`,
  )
  const merged = parseSinglePromptJudgment(
    JSON.stringify({answer: 'yes', explanation: 'because', quotes: ['verbatim quote']}),
    null,
  )

  expect(part).toEqual({answer: 'yes', confidence: 0.75, explanation: 'Randomised.', quotes: ['verbatim quote']})
  expect(merged).toEqual({answer: 'yes', explanation: 'because', quotes: ['verbatim quote']})
})

test('part judgments need a confidence between 0 and 1 inclusive', () => {
  const parse = (confidence: unknown) => {
    return () => {
      return parseFullTextChunkJudgment(JSON.stringify({answer: 'no', confidence, explanation: 'e', quotes: []}), null)
    }
  }

  expect(parse(0)().confidence).toBe(0)
  expect(parse(1)().confidence).toBe(1)
  expect(parse(1.01)).toThrow()
  expect(parse(-0.01)).toThrow()
  expect(parse('0.5')).toThrow()
  expect(parse(undefined)).toThrow()
})

test('single prompt parser extracts JSON after thinking preamble', () => {
  const judgment = parseSinglePromptJudgment(
    'Thinking Process:\n\nI should answer with JSON.\n\n{"answer":"yes","explanation":"because","quotes":null}',
    null,
  )

  expect(judgment.answer).toBe('yes')
  expect(judgment.explanation).toBe('because')
  expect(judgment.quotes).toBeNull()
})

test('chunked mode uses provider cap when present and keeps configured fallback when absent', () => {
  const original = getChunkParallelLimit({chunkCount: 10, providerMaxInflightRequests: null})

  expect(getChunkParallelLimit({chunkCount: 10, providerMaxInflightRequests: 2})).toBe(2)
  expect(getChunkParallelLimit({chunkCount: 3, providerMaxInflightRequests: null})).toBe(3)
  expect(original).toBeGreaterThan(1)
})

test('one call when prompt plus completion fits the smaller of policy and model window, at the exact boundary', () => {
  const chunked = {maxPromptTokens: 24_000, mode: 'chunked'} as const
  const singleOnly = {maxPromptTokens: 24_000, mode: 'single_only'} as const
  const fitting = 24_000 - MAX_COMPLETION_TOKENS

  expect(MAX_COMPLETION_TOKENS).toBe(4000)
  expect(getFullTextCallMode({chunkPolicy: chunked, modelContext: 1_000_000, promptTokens: fitting})).toBe('single')
  expect(getFullTextCallMode({chunkPolicy: chunked, modelContext: 1_000_000, promptTokens: fitting + 1})).toBe(
    'chunked',
  )
  expect(getFullTextCallMode({chunkPolicy: singleOnly, modelContext: 1_000_000, promptTokens: fitting + 1})).toBe(
    'too_large',
  )
  expect(getFullTextCallMode({chunkPolicy: singleOnly, modelContext: 20_000, promptTokens: 16_000})).toBe('single')
  expect(getFullTextCallMode({chunkPolicy: singleOnly, modelContext: 20_000, promptTokens: 16_001})).toBe('too_large')
})

const partArticle = {
  articleCreatedAt: null,
  articleSummary: 'Summary text',
  articleTitle: 'Title text',
  doi: '10.1000/example',
  publicationStatus: null,
  pubmedId: null,
  sourceMetadata: {journalTitle: 'BMJ', publicationYear: 2019},
} as unknown as ArticleRecord

const getPartPrompt = (useMetadata: boolean, useTitle = true) => {
  return getFullTextChunkJudgingUserPrompt({
    article: partArticle,
    chunkCount: 2,
    chunkIndex: 0,
    chunkText: 'Chunk text',
    contentSettings: {useAbstract: false, useFulltext: true, useFulltextNoImages: false, useMetadata, useTitle},
    prompt: {id: 'prompt-1', order: 1, originalText: 'Is this relevant?', promptHeading: null, type: null},
  })
}

test('part prompts place title, metadata and the always-present summary before the part, then the question', () => {
  const withMetadata = getPartPrompt(true)
  const withoutMetadata = getPartPrompt(false)
  const withoutTitle = getPartPrompt(true, false)
  const sectionPositions = [
    '## article_title',
    '## article_metadata',
    '## article_summary',
    '## article_fulltext_part',
  ].map((section) => {
    return withMetadata.indexOf(section)
  })

  expect(
    sectionPositions.every((position) => {
      return position >= 0
    }),
  ).toBe(true)
  expect(sectionPositions).toEqual(
    [...sectionPositions].sort((left, right) => {
      return left - right
    }),
  )
  expect(withMetadata).toContain('journal: BMJ\nyear: 2019\ndoi: 10.1000/example')
  expect(withoutMetadata).not.toContain('article_metadata')
  expect(withoutTitle.startsWith('## article_metadata')).toBe(true)
  expect(withMetadata).toContain('part: 1 of 2')
  expect(withMetadata.indexOf('## Question')).toBeGreaterThan(withMetadata.indexOf('Chunk text'))
})

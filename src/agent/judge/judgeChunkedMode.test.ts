import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {buildEvidenceUserPrompt, getChunkParallelLimit} from '../judge.ts'
import {parseSinglePromptEvidence} from './parseSinglePromptEvidence.ts'
import {parseSinglePromptJudgment} from './parseSinglePromptJudgment.ts'

test('chunked mode schemas: evidence + final parse', () => {
  const evidenceJson = JSON.stringify({facts: ['fact 1'], quotes: ['verbatim quote']})
  const evidence = parseSinglePromptEvidence(evidenceJson)
  expect(evidence.facts).toEqual(['fact 1'])
  expect(evidence.quotes).toEqual(['verbatim quote'])

  const finalJson = JSON.stringify({answer: 'yes', explanation: 'because', quotes: ['verbatim quote']})
  const judgment = parseSinglePromptJudgment(finalJson, null)
  expect(judgment.answer).toBe('yes')
  expect(judgment.explanation).toBe('because')
  expect(judgment.quotes).toEqual(['verbatim quote'])
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

const evidencePromptArticle = {
  articleCreatedAt: null,
  articleSummary: 'Summary text',
  articleTitle: 'Title text',
  doi: '10.1000/example',
  publicationStatus: null,
  pubmedId: null,
  sourceMetadata: {journalTitle: 'BMJ', publicationYear: 2019},
} as unknown as ArticleRecord
const evidencePromptQuestion = {
  id: 'prompt-1',
  order: 1,
  originalText: 'Is this relevant?',
  promptHeading: null,
  type: null,
}
const evidenceContentSettings = {
  useAbstract: true,
  useFulltext: true,
  useFulltextNoImages: false,
  useMetadata: true,
  useTitle: true,
}
const getEvidencePrompt = (params: {includeSummary: boolean; includeTitle: boolean; useMetadata: boolean}) => {
  return buildEvidenceUserPrompt({
    article: evidencePromptArticle,
    chunkCount: 2,
    chunkField: 'fullText',
    chunkIndex: 0,
    chunkText: 'Chunk text',
    contentSettings: {...evidenceContentSettings, useMetadata: params.useMetadata},
    includeSummary: params.includeSummary,
    includeTitle: params.includeTitle,
    prompt: evidencePromptQuestion,
    provider: 'anthropic',
  })
}

test('chunked evidence prompt places the article_metadata block after the title and before the summary', () => {
  expect(getEvidencePrompt({includeSummary: true, includeTitle: true, useMetadata: true})).toBe(
    '## article_title\n\nTitle text\n\n## article_metadata\n\njournal: BMJ\nyear: 2019\ndoi: 10.1000/example\n\n## article_summary\n\nSummary text\n\n## article_fulltext\n\nchunk_index: 1\nchunk_count: 2\n\nChunk text\n\n## Question\n\nIs this relevant?\n\noutput_type: string',
  )
})

test('chunked evidence prompt keeps the article_metadata block in every inclusion fallback', () => {
  const withoutSummary = getEvidencePrompt({includeSummary: false, includeTitle: true, useMetadata: true})
  const minimal = getEvidencePrompt({includeSummary: false, includeTitle: false, useMetadata: true})

  expect(withoutSummary).toContain('## article_title\n\nTitle text\n\n## article_metadata\n\njournal: BMJ')
  expect(withoutSummary).not.toContain('## article_summary')
  expect(
    minimal.startsWith('## article_metadata\n\njournal: BMJ\nyear: 2019\ndoi: 10.1000/example\n\n## article_fulltext'),
  ).toBe(true)
})

test('chunked evidence prompt leaves the article_metadata block out when useMetadata is off', () => {
  const withMetadata = getEvidencePrompt({includeSummary: true, includeTitle: true, useMetadata: true})
  const withoutMetadata = getEvidencePrompt({includeSummary: true, includeTitle: true, useMetadata: false})

  expect(withoutMetadata).not.toContain('article_metadata')
  expect(withMetadata.replace('## article_metadata\n\njournal: BMJ\nyear: 2019\ndoi: 10.1000/example\n\n', '')).toBe(
    withoutMetadata,
  )
})

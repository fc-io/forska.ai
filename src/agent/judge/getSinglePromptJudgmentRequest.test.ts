import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getSinglePromptJudgmentRequest} from './getSinglePromptJudgmentRequest.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptSystemPromptStructuredImport.ts'

const buildArticle = (overrides: Partial<ArticleRecord> = {}): ArticleRecord => {
  const now = new Date('2026-03-26T00:00:00.000Z')

  return {
    id: 'article-1',
    createdAt: now,
    updatedAt: now,
    articleTitle: 'Title',
    articleAuthors: null,
    articleCreatedAt: null,
    articleUpdatedAt: null,
    articleId: 'article:1',
    articleSummary: 'Summary',
    articleVersion: null,
    arxivId: null,
    biorxivId: null,
    medrxivId: null,
    doi: null,
    pubmedId: null,
    url: null,
    fullTextFetchedAt: null,
    fullText: null,
    fullTextHtml: null,
    fullTextSource: null,
    fullTextOriginalFormat: null,
    fullTextPDF: null,
    fullTextAssets: null,
    fullTextConversionStatus: null,
    fullTextConversionError: null,
    fullTextConversionAttempts: null,
    fullTextConversionModelId: null,
    fullTextConversionMetadata: null,
    fullTextCharCount: null,
    contentHash: null,
    importRoute: null,
    originalData: null,
    sourceMetadata: null,
    publicationStatus: null,
    ...overrides,
  }
}

test('getSinglePromptJudgmentRequest combines system prompt, user prompt, and record text for standard articles', () => {
  const result = getSinglePromptJudgmentRequest({
    article: buildArticle({articleTitle: 'Healthcare title', articleSummary: 'Healthcare summary'}),
    contentSettings: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
    prompt: {
      id: 'prompt-1',
      originalText: 'Is this about healthcare?',
      order: 1,
      promptHeading: 'Healthcare',
      type: `'yes' | 'no' | 'unsure'`,
    },
    provider: 'openai',
  })

  expect(result.systemPrompt).toContain('You are a helpful deep research assistant.')
  expect(result.userPrompt).toContain('<SOURCE_TEXT_START>')
  expect(result.userPrompt).toContain('Healthcare title')
  expect(result.userPrompt).toContain('Is this about healthcare?')
  expect(result.recordText).toBe('Healthcare title\n\nHealthcare summary\n\n')
})

test('getSinglePromptJudgmentRequest uses structured import system prompt and raw source text for Anthropic', () => {
  const result = getSinglePromptJudgmentRequest({
    article: buildArticle({
      articleSummary: 'Registry metadata summary',
      articleTitle: 'Registry title',
      importRoute: 'structured-file:registry-entry.json',
    }),
    contentSettings: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
    prompt: {
      id: 'prompt-2',
      originalText: 'Is this about healthcare?',
      order: 2,
      promptHeading: 'Healthcare',
      type: `'yes' | 'no' | 'unsure'`,
    },
    provider: 'anthropic',
  })

  expect(result.systemPrompt).toBe(SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT)
  expect(result.userPrompt).not.toContain('<SOURCE_TEXT_START>')
  expect(result.userPrompt).toContain('## article_title\n\nRegistry title')
})

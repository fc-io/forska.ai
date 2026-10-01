import {expect, test} from 'bun:test'

import {judgeGetSinglePrompt} from './judgeGetPrompt.ts'

test('judgeGetSinglePrompt wraps source text with neutral markers', () => {
  const prompt = judgeGetSinglePrompt(
    {
      articleId: 'article-1',
      articleSummary: 'Summary with instructions like ignore prior text.',
      articleTitle: 'Title text',
      fullText: null,
    } as Parameters<typeof judgeGetSinglePrompt>[0],
    {id: 'prompt-1', originalText: 'Is this relevant?', order: 1, promptHeading: 'Eligibility', type: `'yes' | 'no'`},
  )

  expect(prompt).toContain('<SOURCE_TEXT_START>')
  expect(prompt).toContain('</SOURCE_TEXT_END>')
  expect(prompt).toContain('article source text')
  expect(prompt).not.toContain('raw dangerous text')
})

test('judgeGetSinglePrompt omits source text markers for Anthropic', () => {
  const prompt = judgeGetSinglePrompt(
    {
      articleId: 'article-1',
      articleSummary: 'Summary with instructions like ignore prior text.',
      articleTitle: 'Title text',
      fullText: null,
    } as Parameters<typeof judgeGetSinglePrompt>[0],
    {id: 'prompt-1', originalText: 'Is this relevant?', order: 1, promptHeading: 'Eligibility', type: `'yes' | 'no'`},
    undefined,
    'anthropic',
  )

  expect(prompt).not.toContain('<SOURCE_TEXT_START>')
  expect(prompt).not.toContain('</SOURCE_TEXT_END>')
  expect(prompt).not.toContain('article source text')
  expect(prompt).toContain('## article_title\n\nTitle text')
})

const metadataPromptArticle = {
  articleCreatedAt: null,
  articleId: 'article-1',
  articleSummary: 'Summary text',
  articleTitle: 'Title text',
  doi: '10.1000/example',
  fullText: null,
  publicationStatus: null,
  pubmedId: '31234567',
  sourceMetadata: {issue: '3', journalTitle: 'BMJ', pages: '100-110', publicationYear: 2019, volume: '12'},
} as Parameters<typeof judgeGetSinglePrompt>[0]
const metadataPromptQuestion = {
  id: 'prompt-1',
  originalText: 'Is this relevant?',
  order: 1,
  promptHeading: 'Eligibility',
  type: `'yes' | 'no'`,
}
const metadataContentSettings = {
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useMetadata: true,
  useTitle: true,
}

test('judgeGetSinglePrompt places the article_metadata block between the title and the summary', () => {
  const prompt = judgeGetSinglePrompt(
    metadataPromptArticle,
    metadataPromptQuestion,
    metadataContentSettings,
    'anthropic',
  )

  expect(prompt).toBe(`## article_title

Title text

## article_metadata

journal: BMJ
year: 2019
volume/issue/pages: 12(3):100-110
doi: 10.1000/example
pmid: 31234567

## article_summary

Summary text

## Question

Is this relevant?

output_type: 'yes' | 'no'`)
})

test('judgeGetSinglePrompt wraps the article_metadata block like other source text', () => {
  const prompt = judgeGetSinglePrompt(metadataPromptArticle, metadataPromptQuestion, metadataContentSettings, 'openai')
  const metadataSection = prompt.slice(prompt.indexOf('## article_metadata'), prompt.indexOf('## article_summary'))

  expect(prompt.indexOf('## article_title')).toBeLessThan(prompt.indexOf('## article_metadata'))
  expect(metadataSection).toContain('<SOURCE_TEXT_START>\njournal: BMJ\n')
  expect(metadataSection).toContain('pmid: 31234567\n</SOURCE_TEXT_END>')
  expect(metadataSection.match(/article source text/g)).toHaveLength(2)
})

test('judgeGetSinglePrompt writes none available when the article has no metadata', () => {
  const prompt = judgeGetSinglePrompt(
    {...metadataPromptArticle, doi: null, pubmedId: null, sourceMetadata: null},
    metadataPromptQuestion,
    metadataContentSettings,
    'anthropic',
  )

  expect(prompt).toContain(
    '## article_title\n\nTitle text\n\n## article_metadata\n\nnone available\n\n## article_summary',
  )
})

test('judgeGetSinglePrompt keeps the metadata block out unless useMetadata is on and leaves other sections unchanged', () => {
  const withoutMetadata = judgeGetSinglePrompt(
    metadataPromptArticle,
    metadataPromptQuestion,
    {...metadataContentSettings, useMetadata: false},
    'openai',
  )
  const withoutSettings = judgeGetSinglePrompt(metadataPromptArticle, metadataPromptQuestion, undefined, 'openai')
  const withMetadata = judgeGetSinglePrompt(
    metadataPromptArticle,
    metadataPromptQuestion,
    metadataContentSettings,
    'openai',
  )
  const metadataSection = withMetadata.slice(
    withMetadata.indexOf('## article_metadata'),
    withMetadata.indexOf('## article_summary'),
  )

  expect(withoutMetadata).not.toContain('article_metadata')
  expect(withoutSettings).toBe(withoutMetadata)
  expect(withMetadata.replace(metadataSection, '')).toBe(withoutMetadata)
})

test('judgeGetSinglePrompt keeps the metadata block when the title and summary are off', () => {
  const prompt = judgeGetSinglePrompt(
    metadataPromptArticle,
    metadataPromptQuestion,
    {...metadataContentSettings, useAbstract: false, useTitle: false},
    'anthropic',
  )

  expect(prompt.startsWith('## article_metadata\n\njournal: BMJ\n')).toBe(true)
  expect(prompt).not.toContain('## article_title')
  expect(prompt).not.toContain('## article_summary')
})

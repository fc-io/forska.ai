import {expect, test} from 'bun:test'

import {
  type ArticleFullTextVersions,
  getArticleFullTextVersionDifferences,
  getFullTextReconversionMessage,
  isArticleFullTextStaleForStrategy,
} from './judgmentJobFullTextReconversion.ts'

const inputs = {
  canonicalTextVersion: 'canonical-v1',
  converterKind: 'mineru' as const,
  converterOptionsHash: 'options-hash',
  converterVersion: '4.0.12',
}

const matchingArticle: ArticleFullTextVersions = {...inputs}

test('an article converted with the strategy inputs is current', () => {
  expect(getArticleFullTextVersionDifferences(matchingArticle, inputs)).toEqual([])
  expect(isArticleFullTextStaleForStrategy(matchingArticle, inputs)).toBe(false)
})

test('each converter or canonical input that differs is named', () => {
  expect(getArticleFullTextVersionDifferences({...matchingArticle, converterVersion: '4.0.11'}, inputs)).toEqual([
    'converterVersion',
  ])
  expect(getArticleFullTextVersionDifferences({...matchingArticle, converterKind: 'docling'}, inputs)).toEqual([
    'converterKind',
  ])
  expect(getArticleFullTextVersionDifferences({...matchingArticle, converterOptionsHash: 'other'}, inputs)).toEqual([
    'converterOptionsHash',
  ])
  expect(
    getArticleFullTextVersionDifferences({...matchingArticle, canonicalTextVersion: 'canonical-v0'}, inputs),
  ).toEqual(['canonicalTextVersion'])
})

test('an article converted before converter tracking is stale on every input', () => {
  const untracked: ArticleFullTextVersions = {
    canonicalTextVersion: null,
    converterKind: null,
    converterOptionsHash: null,
    converterVersion: null,
  }

  expect(getArticleFullTextVersionDifferences(untracked, inputs)).toEqual([
    'canonicalTextVersion',
    'converterKind',
    'converterOptionsHash',
    'converterVersion',
  ])
  expect(isArticleFullTextStaleForStrategy(untracked, inputs)).toBe(true)
})

test('the reconversion message names the count and the strategy label with its id', () => {
  const strategy = {id: 'fts-0123456789abcdef', label: 'mineru 4.0.12 / none / chunked 48k'}

  expect(getFullTextReconversionMessage({articleCount: 1, strategy})).toBe(
    '1 article is being reconverted for strategy mineru 4.0.12 / none / chunked 48k (fts-0123456789abcdef); start again when conversion has finished.',
  )
  expect(getFullTextReconversionMessage({articleCount: 12, strategy})).toBe(
    '12 articles are being reconverted for strategy mineru 4.0.12 / none / chunked 48k (fts-0123456789abcdef); start again when conversion has finished.',
  )
})

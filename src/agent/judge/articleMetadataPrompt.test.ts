import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getArticleMetadataPromptText} from './articleMetadataPrompt.ts'

const buildArticle = (overrides: Partial<ArticleRecord> = {}): ArticleRecord => {
  return {
    articleAuthors: null,
    articleCreatedAt: null,
    articleId: 'article:1',
    articleSummary: 'Summary',
    articleTitle: 'Title',
    articleUpdatedAt: null,
    articleVersion: null,
    arxivId: null,
    biorxivId: null,
    contentHash: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    doi: null,
    fullText: null,
    fullTextAssets: null,
    fullTextCharCount: null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: null,
    fullTextFetchedAt: null,
    fullTextHtml: null,
    fullTextOriginalFormat: null,
    fullTextPDF: null,
    fullTextSource: null,
    id: 'article-1',
    importRoute: null,
    medrxivId: null,
    originalData: null,
    publicationStatus: null,
    pubmedId: null,
    sourceMetadata: null,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    url: null,
    ...overrides,
  }
}

test('getArticleMetadataPromptText writes every available line in a fixed order', () => {
  expect(
    getArticleMetadataPromptText(
      buildArticle({
        articleCreatedAt: new Date('2001-05-01T00:00:00.000Z'),
        doi: '10.1000/example',
        publicationStatus: 'published',
        pubmedId: '31234567',
        sourceMetadata: {
          accessionNumber: 'AN-1',
          issue: '3',
          journalTitle: 'BMJ',
          pages: '100-110',
          publicationMonth: 'Mar',
          publicationType: 'JOUR',
          publicationYear: 2019,
          volume: '12',
        },
      }),
    ),
  ).toBe(
    [
      'journal: BMJ',
      'year: 2019',
      'volume/issue/pages: 12(3):100-110',
      'publication_type: JOUR',
      'doi: 10.1000/example',
      'pmid: 31234567',
    ].join('\n'),
  )
})

test('getArticleMetadataPromptText reads JSON text source metadata and writes only the parts present', () => {
  expect(
    getArticleMetadataPromptText(
      buildArticle({sourceMetadata: JSON.stringify({journalTitle: 'Lancet', pages: 'e12'}), pubmedId: '123'}),
    ),
  ).toBe('journal: Lancet\nvolume/issue/pages: e12\npmid: 123')
  expect(getArticleMetadataPromptText(buildArticle({sourceMetadata: {issue: '4', pages: '7-9'}}))).toBe(
    'volume/issue/pages: (4):7-9',
  )
  expect(getArticleMetadataPromptText(buildArticle({sourceMetadata: {volume: '12'}}))).toBe('volume/issue/pages: 12')
})

test('getArticleMetadataPromptText falls back to the article created year, publication status and preprint flag', () => {
  expect(
    getArticleMetadataPromptText(
      buildArticle({
        articleCreatedAt: new Date('2024-02-03T00:00:00.000Z'),
        publicationStatus: 'accepted',
        sourceMetadata: {isPreprint: true, journalTitle: 'ClinicalTrials.gov'},
      }),
    ),
  ).toBe('journal: ClinicalTrials.gov\nyear: 2024\npublication_type: accepted')
  expect(
    getArticleMetadataPromptText(
      buildArticle({articleCreatedAt: '2023-07-01T00:00:00.000Z' as never, sourceMetadata: {isPreprint: true}}),
    ),
  ).toBe('year: 2023\npublication_type: preprint')
})

test('getArticleMetadataPromptText returns none available when nothing is known', () => {
  expect(getArticleMetadataPromptText(buildArticle())).toBe('none available')
  expect(getArticleMetadataPromptText(buildArticle({doi: '  ', sourceMetadata: {journalTitle: ''}}))).toBe(
    'none available',
  )
})

test('getArticleMetadataPromptText tolerates malformed source metadata and unknown keys', () => {
  expect(getArticleMetadataPromptText(buildArticle({sourceMetadata: '{not json'}))).toBe('none available')
  expect(getArticleMetadataPromptText(buildArticle({sourceMetadata: ['BMJ']}))).toBe('none available')
  expect(getArticleMetadataPromptText(buildArticle({sourceMetadata: 42}))).toBe('none available')
  expect(
    getArticleMetadataPromptText(
      buildArticle({
        articleCreatedAt: 'not a date' as never,
        sourceMetadata: {
          covidence: {articleKey: 'k'},
          journalTitle: 'Journal\nof   Tests',
          publicationYear: 'unknown',
          secret: 'ignored',
          volume: {nested: true},
        },
      }),
    ),
  ).toBe('journal: Journal of Tests')
})

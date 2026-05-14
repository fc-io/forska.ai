import {expect, test} from 'bun:test'

import {getArticleUrl} from './getArticleUrl.ts'

test('prefers explicit canonical article URL fields', () => {
  const url = getArticleUrl({
    doi: '10.1000/source-doi',
    sourceUrl: 'https://source.example/articles/1',
    url: 'https://canonical.example/articles/1',
  })

  expect(url).toBe('https://canonical.example/articles/1')
})

test('uses scoped Covidence source URL fields before identifier-derived links', () => {
  const url = getArticleUrl({
    doi: '10.1000/source-doi',
    scopedRawPayload: {covidence: {citation: {url: 'https://covidence-source.example/ref-42'}}},
  })

  expect(url).toBe('https://covidence-source.example/ref-42')
})

test('builds identifier-derived URLs from explicit identifier fields', () => {
  expect(getArticleUrl({arxivId: 'arXiv:2401.12345v2'})).toBe('https://arxiv.org/abs/2401.12345')
  expect(getArticleUrl({biorxivId: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1.full.pdf'})).toBe(
    'https://www.biorxiv.org/content/10.1101/2024.01.01.123456',
  )
  expect(getArticleUrl({medrxivId: '10.1101/2024.01.01.123456'})).toBe(
    'https://www.medrxiv.org/content/10.1101/2024.01.01.123456',
  )
  expect(getArticleUrl({doi: 'https://doi.org/10.1000/example'})).toBe('https://doi.org/10.1000/example')
  expect(getArticleUrl({pubmedId: 'pmid:001234'})).toBe('https://pubmed.ncbi.nlm.nih.gov/1234/')
})

test('does not parse legacy article id prefixes as URL inputs', () => {
  const url = getArticleUrl({articleId: 'pmid:1234'})

  expect(url).toBe('')
})

test('falls back to normalized source metadata links', () => {
  const url = getArticleUrl({
    sourceMetadata: {
      fullTextLinks: [{url: 'https://source.example/full-text', site: 'source'}],
      isPreprint: false,
      journalTitle: null,
      preprintHostLabel: null,
      preprintSource: null,
    },
  })

  expect(url).toBe('https://source.example/full-text')
})

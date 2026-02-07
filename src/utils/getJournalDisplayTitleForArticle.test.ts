import {expect, test} from 'bun:test'

import {getJournalDisplayTitleForArticle} from './getJournalDisplayTitleForArticle.ts'

test('returns explicit journal title when available', () => {
  const value = getJournalDisplayTitleForArticle({
    journalTitle: '  Nature  ',
    articleId: 'ppr:PPR1083296',
    originalData: {source: 'PPR', pubTypeList: {pubType: ['Preprint']}, bookOrReportDetails: {publisher: 'arXiv'}},
  })

  expect(value).toBe('Nature')
})

test('returns journal title from original data when field is missing', () => {
  const value = getJournalDisplayTitleForArticle({originalData: {journalInfo: {journal: {title: 'Lancet'}}}})

  expect(value).toBe('Lancet')
})

test('returns source in parentheses for europe pmc src:ppr preprints', () => {
  const value = getJournalDisplayTitleForArticle({
    articleId: 'ppr:PPR1083296',
    originalData: {
      source: 'PPR',
      pubTypeList: {pubType: ['Preprint']},
      bookOrReportDetails: {publisher: 'arXiv'},
      fullTextUrlList: {fullTextUrl: [{site: 'arXiv'}]},
    },
  })

  expect(value).toBe('(arxiv)')
})

test('falls back to ppr when src:ppr has no provider source', () => {
  const value = getJournalDisplayTitleForArticle({
    articleId: 'ppr:PPR1151608',
    originalData: {source: 'PPR', pubTypeList: {pubType: ['Preprint']}},
  })

  expect(value).toBe('(ppr)')
})

test('does not show source for non-preprints without a journal', () => {
  const value = getJournalDisplayTitleForArticle({
    articleId: 'pmid:41369737',
    originalData: {source: 'MED', pubTypeList: {pubType: ['Journal Article']}},
  })

  expect(value).toBeNull()
})

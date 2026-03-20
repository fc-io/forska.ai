import {expect, test} from 'bun:test'

import {getArticleSourceMetadata, getArticleSourceMetadataValue, getOriginalDoi} from './articleSourceMetadata.ts'

test('extracts doi from original data', () => {
  expect(getOriginalDoi({doi: '10.1000/test-doi'})).toBe('10.1000/test-doi')
})

test('builds normalized source metadata from original data', () => {
  expect(
    getArticleSourceMetadata({
      articleId: 'ppr:PPR1083296',
      originalData: {
        doi: '10.1000/test-doi',
        source: 'PPR',
        pubTypeList: {pubType: ['Preprint']},
        bookOrReportDetails: {publisher: 'arXiv'},
        fullTextUrlList: {
          fullTextUrl: [
            {
              url: 'https://example.org/paper.pdf',
              site: 'arXiv',
              availability: 'Open access',
              availabilityCode: 'OA',
              documentStyle: 'pdf',
            },
          ],
        },
      },
    }),
  ).toEqual({
    journalTitle: null,
    preprintSource: 'arxiv',
    isPreprint: true,
    fullTextLinks: [
      {
        url: 'https://example.org/paper.pdf',
        site: 'arXiv',
        availability: 'Open access',
        availabilityCode: 'OA',
        documentStyle: 'pdf',
      },
    ],
  })
})

test('reads normalized source metadata values', () => {
  expect(
    getArticleSourceMetadataValue({
      journalTitle: 'Nature',
      preprintSource: 'arxiv',
      isPreprint: true,
      fullTextLinks: [{url: 'https://example.org/paper.pdf', site: 'arXiv'}],
    }),
  ).toEqual({
    journalTitle: 'Nature',
    preprintSource: 'arxiv',
    isPreprint: true,
    fullTextLinks: [
      {
        url: 'https://example.org/paper.pdf',
        site: 'arXiv',
        availability: null,
        availabilityCode: null,
        documentStyle: null,
      },
    ],
  })
})

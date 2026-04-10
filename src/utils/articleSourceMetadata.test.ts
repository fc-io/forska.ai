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
    preprintHostLabel: 'arXiv',
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
      preprintHostLabel: 'arXiv',
      isPreprint: true,
      fullTextLinks: [{url: 'https://example.org/paper.pdf', site: 'arXiv'}],
    }),
  ).toEqual({
    journalTitle: 'Nature',
    preprintSource: 'arxiv',
    preprintHostLabel: 'arXiv',
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
    covidence: null,
  })
})

test('keeps europe pmc ppr source code and stores publisher label', () => {
  expect(
    getArticleSourceMetadata({
      articleId: 'ppr:PPR1168632',
      originalData: {
        source: 'PPR',
        pubTypeList: {pubType: ['Preprint']},
        bookOrReportDetails: {publisher: 'EcoEvoRxiv'},
      },
    }),
  ).toEqual({
    journalTitle: null,
    preprintSource: 'ppr',
    preprintHostLabel: 'EcoEvoRxiv',
    isPreprint: true,
    fullTextLinks: [],
  })
})

test('infers known preprint hosts from doi prefixes', () => {
  expect(getArticleSourceMetadata({articleId: 'ppr:PPR815164', doi: '10.21203/rs.3.rs-3955734/v1'})).toEqual({
    journalTitle: null,
    preprintSource: 'ppr',
    preprintHostLabel: 'Research Square',
    isPreprint: true,
    fullTextLinks: [],
  })
})

test('reads covidence source metadata values', () => {
  expect(
    getArticleSourceMetadataValue({
      journalTitle: 'BMJ',
      covidence: {
        articleKey: 'covidence:#5001',
        articleKeySource: 'covidence',
        recordKey: 'covidence:#5001',
        recordKeySource: 'covidence',
        studyKey: 'doi:10.1000/example',
        studyKeySource: 'doi',
        mode: 'title_abstract',
        sourceFileNames: ['screen.csv', 'irrelevant.csv'],
        stageMembership: {all: true, excluded: false, full_text: false, included: false, irrelevant: true},
        tags: ['not rct'],
        covidenceIds: ['#5001'],
        referenceIds: ['12345'],
        duplicateStudyRecordCount: 2,
        hasDuplicateStudyRecords: true,
        hasStudyDecisionConflict: true,
        seededHumanJudgmentAnswer: 'no',
        isSeededHumanJudgmentAnswered: true,
      },
    }),
  ).toEqual({
    journalTitle: 'BMJ',
    preprintSource: null,
    preprintHostLabel: null,
    isPreprint: false,
    fullTextLinks: [],
    covidence: {
      articleKey: 'covidence:#5001',
      articleKeySource: 'covidence',
      recordKey: 'covidence:#5001',
      recordKeySource: 'covidence',
      studyKey: 'doi:10.1000/example',
      studyKeySource: 'doi',
      mode: 'title_abstract',
      sourceFileNames: ['screen.csv', 'irrelevant.csv'],
      stageMembership: {all: true, excluded: false, full_text: false, included: false, irrelevant: true},
      tags: ['not rct'],
      covidenceIds: ['#5001'],
      referenceIds: ['12345'],
      duplicateStudyRecordCount: 2,
      hasDuplicateStudyRecords: true,
      hasStudyDecisionConflict: true,
      seededHumanJudgmentAnswer: 'no',
      isSeededHumanJudgmentAnswered: true,
    },
  })
})

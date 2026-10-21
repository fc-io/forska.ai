import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {
  getArticleMetadataLines,
  getArticleMetadataPromptText,
  getArticleMetadataSourceText,
} from './articleMetadataPrompt.ts'

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
      'accession: AN-1',
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

test('getArticleMetadataLines returns the prompt labels and values in prompt order', () => {
  expect(
    getArticleMetadataLines(
      buildArticle({
        articleCreatedAt: new Date('2001-05-01T00:00:00.000Z'),
        doi: '10.1000/example',
        publicationStatus: 'published',
        pubmedId: '31234567',
        sourceMetadata: {issue: '3', journalTitle: 'BMJ', pages: '100-110', publicationYear: 2019, volume: '12'},
      }),
    ),
  ).toEqual([
    {label: 'journal', value: 'BMJ'},
    {label: 'year', value: '2019'},
    {label: 'volume/issue/pages', value: '12(3):100-110'},
    {label: 'publication_type', value: 'published'},
    {label: 'doi', value: '10.1000/example'},
    {label: 'pmid', value: '31234567'},
  ])
  expect(getArticleMetadataLines(buildArticle())).toEqual([])
  expect(getArticleMetadataLines(buildArticle({doi: '  ', sourceMetadata: '{not json'}))).toEqual([])
})

test('getArticleMetadataLines accepts an unvalidated publication status string like the judge article read', () => {
  expect(
    getArticleMetadataLines({
      articleCreatedAt: null,
      doi: null,
      publicationStatus: 'in press',
      pubmedId: null,
      sourceMetadata: null,
    }),
  ).toEqual([{label: 'publication_type', value: 'in press'}])
})

test('getArticleMetadataPromptText renders exactly the getArticleMetadataLines lines', () => {
  const articles = [
    buildArticle({
      articleCreatedAt: new Date('2024-02-03T00:00:00.000Z'),
      doi: '10.1000/x',
      publicationStatus: 'accepted',
      pubmedId: '99',
      sourceMetadata: {isPreprint: true, journalTitle: 'Journal\nof   Tests', pages: 'e12'},
    }),
    buildArticle({sourceMetadata: JSON.stringify({issue: '4', pages: '7-9'})}),
    buildArticle({sourceMetadata: {volume: '12'}}),
  ]

  articles.map((article) => {
    return expect(getArticleMetadataPromptText(article)).toBe(
      getArticleMetadataLines(article)
        .map((line) => {
          return `${line.label}: ${line.value}`
        })
        .join('\n'),
    )
  })
  expect(getArticleMetadataLines(buildArticle())).toEqual([])
  expect(getArticleMetadataPromptText(buildArticle())).toBe('none available')
  expect(getArticleMetadataSourceText(buildArticle())).toBe('')
  expect(getArticleMetadataSourceText(articles[0] as ArticleRecord)).toBe(
    getArticleMetadataPromptText(articles[0] as ArticleRecord),
  )
})

test('getArticleMetadataLines writes the registry id and source url of a ClinicalTrials.gov record after doi and pmid', () => {
  expect(
    getArticleMetadataPromptText(
      buildArticle({
        sourceMetadata: {
          accessionNumber: 'NCT01234567',
          journalTitle: null,
          publicationYear: 2017,
          sourceUrl: 'https://clinicaltrials.gov/study/NCT01234567',
        },
      }),
    ),
  ).toBe(
    ['year: 2017', 'registry_id: NCT01234567', 'source_url: https://clinicaltrials.gov/study/NCT01234567'].join('\n'),
  )
})

test('getArticleMetadataLines takes the registry id from the source url or a WHO ICTRP journal when the accession has none', () => {
  expect(
    getArticleMetadataLines(
      buildArticle({
        sourceMetadata: {publicationYear: 2014, sourceUrl: 'https://anzctr.org.au/ACTRN12614001209684.aspx'},
      }),
    ),
  ).toEqual([
    {label: 'year', value: '2014'},
    {label: 'registry_id', value: 'ACTRN12614001209684'},
    {label: 'source_url', value: 'https://anzctr.org.au/ACTRN12614001209684.aspx'},
  ])
  expect(
    getArticleMetadataLines(
      buildArticle({
        sourceMetadata: {
          accessionNumber: 'CN-01800343',
          journalTitle: 'https://trialsearch.who.int/Trial2.aspx?TrialID=IRCT138804092106N1',
          sourceUrl: 'https://www.cochranelibrary.com/central/doi/10.1002/central/CN-01800343/full',
        },
      }),
    ),
  ).toEqual([
    {label: 'journal', value: 'https://trialsearch.who.int/Trial2.aspx?TrialID=IRCT138804092106N1'},
    {label: 'registry_id', value: 'IRCT138804092106N1'},
    {label: 'accession', value: 'CN-01800343'},
    {label: 'source_url', value: 'https://www.cochranelibrary.com/central/doi/10.1002/central/CN-01800343/full'},
  ])
})

test('getArticleMetadataLines writes a registry source url without a registry id when the url carries only an internal number', () => {
  expect(
    getArticleMetadataLines(
      buildArticle({sourceMetadata: {sourceUrl: 'http://www.ctri.nic.in/Clinicaltrials/pmaindet2.php?trialid=3379'}}),
    ),
  ).toEqual([{label: 'source_url', value: 'http://www.ctri.nic.in/Clinicaltrials/pmaindet2.php?trialid=3379'}])
})

test('getArticleMetadataLines picks the registry url out of a concatenated Embase export url', () => {
  expect(
    getArticleMetadataLines(
      buildArticle({
        sourceMetadata: {
          journalTitle: 'clinicaltrials.gov',
          sourceUrl:
            'https://www.embase.com/search/results?subaction=viewrecord&id=LNCT00144638&from=exporthttps://clinicaltrials.gov/study/NCT00144638',
        },
      }),
    ),
  ).toEqual([
    {label: 'journal', value: 'clinicaltrials.gov'},
    {label: 'registry_id', value: 'NCT00144638'},
    {label: 'source_url', value: 'https://clinicaltrials.gov/study/NCT00144638'},
  ])
})

test('getArticleMetadataLines writes a non-registry source url only when the article has no doi', () => {
  const sourceUrl = 'https://www.embase.com/search/results?subaction=viewrecord&id=L2001234567'

  expect(getArticleMetadataLines(buildArticle({sourceMetadata: {sourceUrl}}))).toEqual([
    {label: 'source_url', value: sourceUrl},
  ])
  expect(getArticleMetadataLines(buildArticle({doi: '10.1000/x', sourceMetadata: {sourceUrl}}))).toEqual([
    {label: 'doi', value: '10.1000/x'},
  ])
  expect(
    getArticleMetadataLines(
      buildArticle({doi: '10.1000/x', sourceMetadata: {sourceUrl: 'https://www.isrctn.com/ISRCTN10957189'}}),
    ),
  ).toEqual([
    {label: 'doi', value: '10.1000/x'},
    {label: 'registry_id', value: 'ISRCTN10957189'},
    {label: 'source_url', value: 'https://www.isrctn.com/ISRCTN10957189'},
  ])
})

test('getArticleMetadataLines writes a non-registry accession under accession and ignores DOI urls and the article url', () => {
  expect(
    getArticleMetadataLines(
      buildArticle({
        sourceMetadata: {accessionNumber: '  WOS:000422265700030 ', sourceUrl: 'https://dx.doi.org/10.1000/alpha'},
        url: 'https://pubmed.ncbi.nlm.nih.gov/31234567/',
      }),
    ),
  ).toEqual([{label: 'accession', value: 'WOS:000422265700030'}])
  expect(getArticleMetadataLines(buildArticle({sourceMetadata: {accessionNumber: '   '}}))).toEqual([])
})

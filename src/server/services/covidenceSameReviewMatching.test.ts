import {expect, test} from 'bun:test'

import {
  type CovidenceBaseRouteMatchRecord,
  getCovidenceBaseRouteMatchIndex,
  getCovidenceSameReviewMatchSummary,
  getSuggestedCovidenceBaseImportRoute,
  resolveCovidenceMatchTier,
} from './covidenceSameReviewMatching.ts'

const baseRecords: CovidenceBaseRouteMatchRecord[] = [
  {articleId: 'article-a', covidenceIds: ['#1'], referenceIds: ['ref-1'], titleYearFirstAuthorHash: 'hash-a'},
  {articleId: 'article-b', covidenceIds: ['#2'], referenceIds: ['ref-2'], titleYearFirstAuthorHash: 'hash-shared'},
  {articleId: 'article-c', covidenceIds: ['#3'], referenceIds: ['ref-shared'], titleYearFirstAuthorHash: 'hash-shared'},
  {articleId: 'article-d', covidenceIds: ['#4'], referenceIds: ['ref-shared'], titleYearFirstAuthorHash: null},
  {articleId: 'article-e', covidenceIds: ['#5'], referenceIds: [], titleYearFirstAuthorHash: 'hash-e'},
  {articleId: 'article-e', covidenceIds: ['#5b'], referenceIds: [], titleYearFirstAuthorHash: 'hash-e'},
]
const index = getCovidenceBaseRouteMatchIndex(baseRecords)
const emptyKeys = {covidenceIds: [], referenceIds: [], titleYearFirstAuthorHash: null}

test('resolveCovidenceMatchTier prefers an existing strong identifier match over every base route tier', () => {
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: ['#1'], referenceIds: ['ref-1'], titleYearFirstAuthorHash: 'hash-a'},
      strongIdentifierArticleIds: ['article-strong'],
    }),
  ).toEqual({articleId: 'article-strong', matchTier: 'strong_identifier', status: 'matched'})
  expect(
    resolveCovidenceMatchTier({index, keys: emptyKeys, strongIdentifierArticleIds: ['article-x', 'article-y']}),
  ).toEqual({articleIds: ['article-x', 'article-y'], matchTier: 'strong_identifier', status: 'ambiguous'})
})

test('resolveCovidenceMatchTier walks Covidence #, Ref and title hash in order and the first hit wins', () => {
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: ['#2'], referenceIds: ['ref-1'], titleYearFirstAuthorHash: 'hash-a'},
      strongIdentifierArticleIds: [],
    }),
  ).toEqual({articleId: 'article-b', matchTier: 'covidence_id', status: 'matched'})
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: ['#999'], referenceIds: ['ref-1'], titleYearFirstAuthorHash: 'hash-e'},
      strongIdentifierArticleIds: [],
    }),
  ).toEqual({articleId: 'article-a', matchTier: 'reference_id', status: 'matched'})
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: ['#999'], referenceIds: ['ref-999'], titleYearFirstAuthorHash: 'hash-e'},
      strongIdentifierArticleIds: [],
    }),
  ).toEqual({articleId: 'article-e', matchTier: 'title_year_first_author', status: 'matched'})
})

test('resolveCovidenceMatchTier reports two or more base articles as ambiguous instead of picking one', () => {
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: [], referenceIds: [], titleYearFirstAuthorHash: 'hash-shared'},
      strongIdentifierArticleIds: [],
    }),
  ).toEqual({articleIds: ['article-b', 'article-c'], matchTier: 'title_year_first_author', status: 'ambiguous'})
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: [], referenceIds: ['ref-shared'], titleYearFirstAuthorHash: 'hash-a'},
      strongIdentifierArticleIds: [],
    }),
  ).toEqual({articleIds: ['article-c', 'article-d'], matchTier: 'reference_id', status: 'ambiguous'})
  expect(
    resolveCovidenceMatchTier({
      index,
      keys: {covidenceIds: ['#5', '#5b'], referenceIds: [], titleYearFirstAuthorHash: null},
      strongIdentifierArticleIds: [],
    }),
  ).toEqual({articleId: 'article-e', matchTier: 'covidence_id', status: 'matched'})
})

test('resolveCovidenceMatchTier ignores excluded article ids in every tier and returns unmatched without keys', () => {
  expect(
    resolveCovidenceMatchTier({
      excludedArticleIds: new Set(['article-dup', 'article-b']),
      index,
      keys: {covidenceIds: ['#2'], referenceIds: [], titleYearFirstAuthorHash: 'hash-shared'},
      strongIdentifierArticleIds: ['article-dup'],
    }),
  ).toEqual({articleId: 'article-c', matchTier: 'title_year_first_author', status: 'matched'})
  expect(resolveCovidenceMatchTier({index, keys: emptyKeys, strongIdentifierArticleIds: []})).toEqual({
    status: 'unmatched',
  })
})

test('getSuggestedCovidenceBaseImportRoute suggests the best route only from a 90 % strong identifier share', () => {
  const routeShare = (importRoute: string, share: number) => {
    return {dataSourceId: null, dataSourceTitle: null, importRoute, matchedRecordCount: 0, share}
  }

  expect(getSuggestedCovidenceBaseImportRoute([routeShare('covidence:low', 0.8999)]).suggestion).toBeNull()
  expect(getSuggestedCovidenceBaseImportRoute([routeShare('covidence:exact', 0.9)]).suggestion?.importRoute).toBe(
    'covidence:exact',
  )
  expect(
    getSuggestedCovidenceBaseImportRoute([
      routeShare('covidence:b', 0.95),
      routeShare('covidence:a', 0.99),
      routeShare('covidence:c', 0.99),
    ]),
  ).toMatchObject({
    routeShares: [{importRoute: 'covidence:a'}, {importRoute: 'covidence:c'}, {importRoute: 'covidence:b'}],
    suggestion: {importRoute: 'covidence:a'},
  })
  expect(getSuggestedCovidenceBaseImportRoute([]).suggestion).toBeNull()
})

test('getCovidenceSameReviewMatchSummary counts matched tiers and lists ambiguous and unmatched records', () => {
  const summary = getCovidenceSameReviewMatchSummary('covidence:base', [
    {
      articleKey: 'covidence:#1',
      keys: emptyKeys,
      resolution: {articleId: 'a', matchTier: 'covidence_id', status: 'matched'},
      title: 'A',
    },
    {
      articleKey: 'covidence:#2',
      keys: emptyKeys,
      resolution: {articleId: 'b', matchTier: 'strong_identifier', status: 'matched'},
      title: 'B',
    },
    {
      articleKey: 'covidence:#3',
      keys: {covidenceIds: ['#3'], referenceIds: ['r3'], titleYearFirstAuthorHash: 'h'},
      resolution: {articleIds: ['x', 'y'], matchTier: 'title_year_first_author', status: 'ambiguous'},
      title: 'C',
    },
    {articleKey: 'covidence:#4', keys: emptyKeys, resolution: {status: 'unmatched'}, title: null},
  ])

  expect(summary).toEqual({
    ambiguous: [
      {
        articleIds: ['x', 'y'],
        articleKey: 'covidence:#3',
        covidenceIds: ['#3'],
        matchTier: 'title_year_first_author',
        referenceIds: ['r3'],
        title: 'C',
      },
    ],
    ambiguousCount: 1,
    baseImportRoute: 'covidence:base',
    countsByTier: {covidence_id: 1, reference_id: 0, strong_identifier: 1, title_year_first_author: 0},
    unmatched: [
      {articleIds: [], articleKey: 'covidence:#4', covidenceIds: [], matchTier: null, referenceIds: [], title: null},
    ],
    unmatchedCount: 1,
  })
})

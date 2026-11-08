import {expect, test} from 'bun:test'

import {
  buildCovidencePackageConfig,
  getCovidenceCandidateMatchKeys,
  getCovidencePackageConfig,
  getCovidencePackageCursor,
} from './covidenceImportService.ts'

const files = (['all', 'irrelevant', 'full_text'] as const).map((fileRole) => {
  return {
    assetPath: `assets/covidence_imports/ds/${fileRole}.csv`,
    fileRole,
    format: 'csv' as const,
    sourceFileName: `${fileRole}.csv`,
  }
})

test('Covidence package config keeps the exact legacy shape without a base import route', () => {
  const config = buildCovidencePackageConfig({files, mode: 'title_abstract'})

  expect(Object.keys(config)).toEqual(['kind', 'version', 'mode', 'files'])
  expect(getCovidencePackageCursor(config)).toBe(
    JSON.stringify({kind: 'covidence_import', version: 1, mode: 'title_abstract', files}),
  )
  expect(buildCovidencePackageConfig({baseImportRoute: null, files, mode: 'title_abstract'})).toEqual(config)
})

test('Covidence package config round-trips a base import route and rejects a non-Covidence one', () => {
  const config = buildCovidencePackageConfig({baseImportRoute: 'covidence:base', files, mode: 'title_abstract'})
  const cursor = getCovidencePackageCursor(config)

  expect(getCovidencePackageConfig(cursor)).toEqual({...config, baseImportRoute: 'covidence:base'})
  expect(getCovidencePackageConfig(JSON.stringify({...config, baseImportRoute: '/api/pubmed'}))).toBeNull()
  expect(getCovidencePackageConfig(JSON.stringify({...config, baseImportRoute: 'covidence:'}))).toBeNull()
  expect(getCovidencePackageConfig(JSON.stringify({...config, baseImportRoute: 42}))).toBeNull()
})

test('getCovidenceCandidateMatchKeys normalizes Covidence # and Ref values and hashes title year first author', () => {
  const keys = getCovidenceCandidateMatchKeys({
    citation: {authors: 'Doe, Jane; Roe, John', published_year: '2020', title: 'Study One'},
    covidenceIds: ['  #12 ', '#12'],
    referenceIds: ['REF  7'],
  })
  const sameStudyKeys = getCovidenceCandidateMatchKeys({
    citation: {authors: 'DOE, JANE', published_year: '2020 Mar', title: 'study one.'},
    covidenceIds: [],
    referenceIds: [],
  })

  expect(keys.covidenceIds).toEqual(['#12'])
  expect(keys.referenceIds).toEqual(['ref 7'])
  expect(keys.titleYearFirstAuthorHash).toMatch(/^[0-9a-f]{64}$/)
  expect(sameStudyKeys.titleYearFirstAuthorHash).toBe(keys.titleYearFirstAuthorHash)
  expect(
    getCovidenceCandidateMatchKeys({citation: {title: 'Study One'}, covidenceIds: [], referenceIds: []})
      .titleYearFirstAuthorHash,
  ).toBeNull()
})

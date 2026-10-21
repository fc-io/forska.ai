import {expect, test} from 'bun:test'

import {getArticleSourceUrl, getArticleSourceUrls} from './articleSourceUrl.ts'

test('getArticleSourceUrl keeps a trimmed http or https url that is not a DOI resolver url', () => {
  expect(getArticleSourceUrl('https://clinicaltrials.gov/study/NCT00005915')).toBe(
    'https://clinicaltrials.gov/study/NCT00005915',
  )
  expect(getArticleSourceUrl('  http://en.irct.ir/trial/1031\n')).toBe('http://en.irct.ir/trial/1031')
  expect(getArticleSourceUrl('HTTP://EN.IRCT.IR/trial/1031')).toBe('HTTP://EN.IRCT.IR/trial/1031')
  expect(getArticleSourceUrl('https://doi.organisation.example/record/1')).toBe(
    'https://doi.organisation.example/record/1',
  )
})

test('getArticleSourceUrl rejects DOIs, DOI resolver urls, other schemes and non-strings', () => {
  const values = [
    'https://dx.doi.org/10.1000/alpha',
    'http://doi.org/10.1000/alpha',
    'HTTPS://WWW.DOI.ORG/10.1000/beta',
    'https://dx.doi.org/0161903/AIM.009',
    'http://doi.org',
    '10.1000/gamma',
    'doi:10.1000/delta',
    'ftp://registry.example/trial/1',
    'clinicaltrials.gov/study/NCT00005915',
    '   ',
    '',
    null,
    undefined,
    42,
  ]

  expect(values.map(getArticleSourceUrl)).toEqual(
    values.map(() => {
      return null
    }),
  )
})

test('getArticleSourceUrls splits concatenated and whitespace separated urls and drops DOI urls', () => {
  expect(
    getArticleSourceUrls(
      'https://www.embase.com/search/results?subaction=viewrecord&id=LNCT00144638&from=exporthttps://clinicaltrials.gov/study/NCT00144638',
    ),
  ).toEqual([
    'https://www.embase.com/search/results?subaction=viewrecord&id=LNCT00144638&from=export',
    'https://clinicaltrials.gov/study/NCT00144638',
  ])
  expect(getArticleSourceUrls('https://a.example/1 https://doi.org/10.1/x\nhttps://b.example/2')).toEqual([
    'https://a.example/1',
    'https://b.example/2',
  ])
  expect(getArticleSourceUrls('https://clinicaltrials.gov/study/NCT00005915')).toEqual([
    'https://clinicaltrials.gov/study/NCT00005915',
  ])
  expect(getArticleSourceUrls('10.1000/x')).toEqual([])
  expect(getArticleSourceUrls(null)).toEqual([])
  expect(getArticleSourceUrls(undefined)).toEqual([])
})

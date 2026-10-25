import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {getComparisonProjectCsvLine} from '../comparisonProjectsRoutesPostExport/comparisonProjectCsvLine.ts'
import {
  type ComparisonProjectCovidenceExportArticle,
  getComparisonProjectCovidenceExportArticle,
} from './comparisonProjectCovidenceExportArticle.ts'
import {
  comparisonProjectCovidenceExportHeaders,
  getComparisonProjectCovidenceExportCsvValues,
} from './comparisonProjectCovidenceExportCsvRow.ts'

const fullTextReviewCsv = readFileSync(
  new URL('../../../../../assets/covidence_study/full_text_review.csv', import.meta.url),
  'utf8',
)

const getCsvRecords = (content: string) => {
  const fields = Array.from(content.matchAll(/("(?:[^"]|"")*"|[^,\r\n"]*)(,|\r?\n|$)/gu))

  return fields.reduce<string[][]>(
    (records, [, rawValue = '', delimiter = ''], index) => {
      const value = rawValue.startsWith('"') ? rawValue.slice(1, -1).replaceAll('""', '"') : rawValue
      const currentRecord = records[records.length - 1] ?? []
      const nextRecords = [...records.slice(0, -1), [...currentRecord, value]]

      return delimiter === ',' || index === fields.length - 1 ? nextRecords : [...nextRecords, []]
    },
    [[]],
  )
}

const getCovidenceCitationKey = (header: string) => {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const getStoredCovidenceCitation = (headers: readonly string[], values: readonly string[]) => {
  return Object.fromEntries(
    headers
      .map((header, index) => {
        return [getCovidenceCitationKey(header), values[index]?.trim() || null] as const
      })
      .filter(([key]) => {
        return key !== 'notes' && key !== 'tags'
      }),
  )
}

const [csvHeaders = [], firstCsvRecord = []] = getCsvRecords(fullTextReviewCsv.slice(0, 20_000))

const sourceMetadataWithoutYear = {
  accessionNumber: '189697998',
  fullTextLinks: [],
  isPreprint: false,
  issue: '1',
  journalTitle: 'Antimicrobial stewardship & healthcare epidemiology : ASHE',
  pages: 'e51',
  preprintHostLabel: null,
  preprintSource: null,
  publicationMonth: 'Feb',
  volume: '5',
} satisfies ComparisonProjectCovidenceExportArticle['sourceMetadata']

const getArticle = (
  overrides: Partial<ComparisonProjectCovidenceExportArticle> = {},
): ComparisonProjectCovidenceExportArticle => {
  return {
    articleAuthors: ['Abbas, Salma', 'Aslam, Seemal'],
    articleId: 'article-1',
    articleSummary: 'Article summary',
    articleTitle: 'Article title',
    covidence: null,
    doi: '10.1017/ash.2025.2',
    pubmedId: '40026775',
    sourceMetadata: {...sourceMetadataWithoutYear, publicationYear: 2025},
    ...overrides,
  }
}

const servingRow = {articleSummary: 'Serving summary', articleTitle: 'Serving title'}

test('the export header is exactly the first line of the Covidence full-text review CSV on disk', () => {
  const firstLine = fullTextReviewCsv.split(/\r?\n/u)[0]?.replace(/^\uFEFF/u, '')

  expect(getComparisonProjectCsvLine([...comparisonProjectCovidenceExportHeaders])).toBe(`${firstLine}\n`)
  expect<string[]>([...comparisonProjectCovidenceExportHeaders]).toEqual(csvHeaders)
})

test('an article with a stored Covidence citation round-trips the Covidence record field for field', () => {
  const notes = firstCsvRecord[14] ? [firstCsvRecord[14]] : []
  const tags = firstCsvRecord[15] ? [firstCsvRecord[15]] : []
  const article = getArticle({
    articleAuthors: ['Someone, Else'],
    articleTitle: 'Canonical title that must not win',
    covidence: {citation: getStoredCovidenceCitation(csvHeaders, firstCsvRecord), notes, tags},
    doi: '10.9999/not-the-citation',
  })

  expect(firstCsvRecord[0]).toBe(
    'Examining the impact of treatment guidelines on outpatient antibiotic prescription trends at a cancer center in Pakistan.',
  )
  expect(firstCsvRecord[1]?.startsWith('Abbas, Salma; Aslam, Seemal;')).toBe(true)
  expect(firstCsvRecord[2]?.startsWith('Objective: To assess the impact')).toBe(true)
  expect(firstCsvRecord).toHaveLength(comparisonProjectCovidenceExportHeaders.length)
  expect(getComparisonProjectCovidenceExportCsvValues(servingRow, article)).toEqual(firstCsvRecord)
  expect(getComparisonProjectCovidenceExportCsvValues(servingRow, article).slice(10, 14)).toEqual([
    'https://dx.doi.org/10.1017/ash.2025.2',
    '40026775',
    '#5011',
    'Abbas 2025',
  ])
})

test('Covidence citations keep blank columns blank, join notes and tags, and read RIS key aliases', () => {
  const article = getArticle({
    covidence: {
      citation: {
        authors: 'Marra AR; de Almeida SM',
        covidence_id: '#77',
        is: '4',
        journal: null,
        publication_year: '2009',
        reference_id: '19000001',
        title: 'RIS title',
        vl: '12',
      },
      notes: ['Reviewer A (2026-04-10)(Screen): first', 'Reviewer B (2026-04-11)(Screen): second'],
      tags: ['Not RCT', 'Possible RCT'],
    },
  })

  expect(getComparisonProjectCovidenceExportCsvValues(servingRow, article)).toEqual([
    'RIS title',
    'Marra AR; de Almeida SM',
    '',
    '2009',
    '',
    '',
    '12',
    '4',
    '',
    '',
    '',
    '19000001',
    '#77',
    '',
    'Reviewer A (2026-04-10)(Screen): first; Reviewer B (2026-04-11)(Screen): second',
    'Not RCT; Possible RCT',
  ])
})

test('an article without a Covidence citation falls back to its own fields', () => {
  expect(getComparisonProjectCovidenceExportCsvValues(servingRow, getArticle())).toEqual([
    'Article title',
    'Abbas, Salma; Aslam, Seemal',
    'Article summary',
    '2025',
    'Feb',
    'Antimicrobial stewardship & healthcare epidemiology : ASHE',
    '5',
    '1',
    'e51',
    '189697998',
    'https://dx.doi.org/10.1017/ash.2025.2',
    '40026775',
    '',
    'Abbas 2025',
    '',
    '',
  ])
})

test('the fallback leaves DOI, Ref, metadata and Study empty when the article has none', () => {
  const values = getComparisonProjectCovidenceExportCsvValues(
    servingRow,
    getArticle({articleAuthors: [], doi: null, pubmedId: null, sourceMetadata: null}),
  )

  expect(values).toEqual(['Article title', '', 'Article summary', '', '', '', '', '', '', '', '', '', '', '', '', ''])
})

test('the fallback Study uses the first author surname without spaces and needs both surname and year', () => {
  const getStudy = (articleAuthors: string[], publicationYear: number | null) => {
    const sourceMetadata =
      publicationYear === null ? sourceMetadataWithoutYear : {...sourceMetadataWithoutYear, publicationYear}

    return getComparisonProjectCovidenceExportCsvValues(servingRow, getArticle({articleAuthors, sourceMetadata}))[13]
  }

  expect(getStudy(['Ab Rahman, Norazida', 'Teng, Cheong Lieng'], 2016)).toBe('AbRahman 2016')
  expect(getStudy(['Diaz-Madriz, Jose Pablo'], 2023)).toBe('Diaz-Madriz 2023')
  expect(getStudy(['Marra AR', 'Sharma S'], 2009)).toBe('Marra 2009')
  expect(getStudy(['Abbas, Salma'], null)).toBe('')
  expect(getStudy([], 2025)).toBe('')
})

test('without an article record the serving row title and summary are exported', () => {
  expect(getComparisonProjectCovidenceExportCsvValues(servingRow, null)).toEqual([
    'Serving title',
    '',
    'Serving summary',
    ...Array.from({length: 13}, () => {
      return ''
    }),
  ])
})

test('repository rows are normalised from DuckDB JSON values', () => {
  const article = getComparisonProjectCovidenceExportArticle({
    articleAuthors: JSON.stringify(['  Abbas, Salma ', '', 'Aslam, Seemal']),
    articleId: 'article-1',
    articleSummary: null,
    articleTitle: 'Title',
    covidence: JSON.stringify({
      citation: {covidence: '#5011', published_year: 2025, title: 'Title', volume: null},
      notes: [' note ', 3, ''],
      tags: ['Not RCT'],
    }),
    doi: null,
    pubmedId: null,
    sourceMetadata: JSON.stringify({journalTitle: 'Journal', publicationYear: '2025'}),
  })

  expect(article.articleAuthors).toEqual(['Abbas, Salma', 'Aslam, Seemal'])
  expect(article.covidence).toEqual({
    citation: {covidence: '#5011', published_year: '2025', title: 'Title', volume: null},
    notes: ['note'],
    tags: ['Not RCT'],
  })
  expect(article.sourceMetadata?.journalTitle).toBe('Journal')
  expect(article.sourceMetadata?.publicationYear).toBe(2025)
  expect(
    getComparisonProjectCovidenceExportArticle({
      articleAuthors: null,
      articleId: 'article-2',
      articleSummary: null,
      articleTitle: null,
      covidence: {notes: []},
      doi: null,
      pubmedId: null,
      sourceMetadata: null,
    }).covidence,
  ).toBeNull()
})

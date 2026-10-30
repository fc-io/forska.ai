import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {parseCovidenceReferenceRows} from '../../../services/covidenceImportService.ts'
import {
  type ComparisonProjectCovidenceExportArticle,
  type ComparisonProjectCovidenceExportCitation,
  getComparisonProjectCovidenceExportArticle,
} from './comparisonProjectCovidenceExportArticle.ts'
import {getComparisonProjectCovidenceExportRisRecord} from './comparisonProjectCovidenceExportRisRecord.ts'

const fullTextReviewCsv = readFileSync(
  new URL('../../../../../assets/covidence_study/full_text_review.csv', import.meta.url),
  'utf8',
)

const getParsedReferenceRows = (content: string, format: 'csv' | 'ris') => {
  const parsed = parseCovidenceReferenceRows({content, fileRole: 'full_text', format, sourceFileName: `test.${format}`})

  if (!parsed.ok) {
    throw new Error(parsed.error.message)
  }

  return parsed.rows
}

const getStoredCovidenceCitation = (
  content: string,
  format: 'csv' | 'ris',
): ComparisonProjectCovidenceExportCitation => {
  const [row] = getParsedReferenceRows(content, format)

  if (!row) {
    throw new Error('Missing Covidence reference row')
  }

  return {citation: row.citation, notes: row.notes ? [row.notes] : [], tags: row.tags}
}

const sourceMetadata = {
  accessionNumber: '189697998',
  fullTextLinks: [],
  isPreprint: false,
  issue: '1',
  journalTitle: 'Antimicrobial stewardship & healthcare epidemiology : ASHE',
  pages: '123-130',
  preprintHostLabel: null,
  preprintSource: null,
  publicationMonth: 'Feb',
  publicationYear: 2025,
  sourceUrl: 'https://clinicaltrials.gov/study/NCT00000001',
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
    sourceMetadata,
    ...overrides,
  }
}

const servingRow = {articleSummary: 'Serving summary', articleTitle: 'Serving title'}
const emptyServingRow = {articleSummary: null, articleTitle: null}

const getRecord = (overrides: Partial<ComparisonProjectCovidenceExportArticle> = {}) => {
  return getComparisonProjectCovidenceExportRisRecord(servingRow, getArticle(overrides))
}

const getCitationRecord = (citation: ComparisonProjectCovidenceExportCitation['citation']) => {
  return getRecord({covidence: {citation, notes: [], tags: []}})
}

const getRecordLines = (record: string) => {
  return record.split('\r\n')
}

const getTagValues = (record: string, tag: string) => {
  return getRecordLines(record)
    .filter((line) => {
      return line.startsWith(`${tag}  - `)
    })
    .map((line) => {
      return line.slice(`${tag}  - `.length)
    })
}

test('a Covidence citation from the full-text review CSV keeps every value of the Covidence record', () => {
  const covidence = getStoredCovidenceCitation(fullTextReviewCsv, 'csv')
  const authors = (covidence.citation.authors ?? '').split('; ')
  const record = getRecord({
    articleAuthors: ['Someone, Else'],
    articleTitle: 'Canonical title that must not win',
    covidence,
    doi: '10.9999/not-the-citation',
  })

  expect(covidence.citation.doi).toBe('https://dx.doi.org/10.1017/ash.2025.2')
  expect(covidence.citation.published_month).toBe('/')
  expect(authors).toHaveLength(15)
  expect(getRecordLines(record)).toEqual([
    'TY  - JOUR',
    'TI  - Examining the impact of treatment guidelines on outpatient antibiotic prescription trends at a cancer center in Pakistan.',
    ...authors.map((author) => {
      return `AU  - ${author}`
    }),
    `AB  - ${(covidence.citation.abstract ?? '').replace(/\s+/gu, ' ').trim()}`,
    'PY  - 2025',
    'JO  - Antimicrobial stewardship & healthcare epidemiology : ASHE',
    'VL  - 5',
    'IS  - 1',
    'SP  - e51',
    'DO  - 10.1017/ash.2025.2',
    'KW  - Not RCT',
    'ID  - #5011',
    'ER  - ',
    '',
    '',
  ])
})

test('a Covidence citation from a Covidence RIS export reads the RIS field names of the import', () => {
  const covidence = getStoredCovidenceCitation(
    [
      'TY  - JOUR',
      'TI  - RIS title',
      'AU  - Marra, Alexandre R',
      'AU  - de Almeida, Silvia M',
      'AB  - RIS abstract',
      'PY  - 2009',
      'JO  - Infection control',
      'VL  - 12',
      'IS  - 4',
      'SP  - 100',
      'EP  - 110',
      'DO  - doi:10.1086/600000',
      'AN  - 19000001',
      'UR  - https://example.com/ris',
      'KW  - Not RCT',
      'KW  - Possible RCT',
      'N1  - Reviewer A (2026-04-10)(Screen): first',
      'ID  - #77',
      'ER  - ',
    ].join('\n'),
    'ris',
  )

  expect(covidence.citation).toMatchObject({ep: '110', is: '4', pmid: '19000001', reference_id: '#77', sp: '100'})
  expect(getRecordLines(getRecord({covidence}))).toEqual([
    'TY  - JOUR',
    'TI  - RIS title',
    'AU  - Marra, Alexandre R',
    'AU  - de Almeida, Silvia M',
    'AB  - RIS abstract',
    'PY  - 2009',
    'JO  - Infection control',
    'VL  - 12',
    'IS  - 4',
    'SP  - 100',
    'EP  - 110',
    'DO  - 10.1086/600000',
    'AN  - 19000001',
    'UR  - https://example.com/ris',
    'KW  - Not RCT',
    'KW  - Possible RCT',
    'N1  - Reviewer A (2026-04-10)(Screen): first',
    'ID  - #77',
    'ER  - ',
    '',
    '',
  ])
})

test('Covidence citation keys fall back in alias order and the Covidence # wins over Ref', () => {
  const record = getCitationRecord({
    accession_number: null,
    covidence: '#5011',
    covidence_id: '#1',
    journal: ' ',
    journal_abbreviation: 'Infect Control',
    pmid: '19000001',
    publication_date: '2019/03/01/',
    published_year: 'n.d.',
    ref: '40026775',
    sp: '100-110',
  })

  expect(getTagValues(record, 'PY')).toEqual(['2019'])
  expect(getTagValues(record, 'JO')).toEqual(['Infect Control'])
  expect(getTagValues(record, 'SP')).toEqual(['100'])
  expect(getTagValues(record, 'EP')).toEqual(['110'])
  expect(getTagValues(record, 'AN')).toEqual(['19000001'])
  expect(getTagValues(record, 'ID')).toEqual(['#5011'])
  expect(getTagValues(getCitationRecord({accession_number: '189697998', pmid: '1'}), 'AN')).toEqual(['189697998'])
  expect(getTagValues(getCitationRecord({covidence_id: '#1', ref: '40026775'}), 'ID')).toEqual(['#1'])
  expect(getTagValues(getCitationRecord({ref: '40026775', reference_id: '2'}), 'ID')).toEqual(['40026775'])
  expect(getTagValues(getCitationRecord({reference_id: '2'}), 'ID')).toEqual(['2'])
  expect(getTagValues(getCitationRecord({vl: '3', volume: '4'}), 'VL')).toEqual(['4'])
  expect(getTagValues(getCitationRecord({is: '2'}), 'IS')).toEqual(['2'])
})

test('an article without a Covidence citation exports its own fields', () => {
  expect(getRecordLines(getRecord())).toEqual([
    'TY  - JOUR',
    'TI  - Article title',
    'AU  - Abbas, Salma',
    'AU  - Aslam, Seemal',
    'AB  - Article summary',
    'PY  - 2025',
    'JO  - Antimicrobial stewardship & healthcare epidemiology : ASHE',
    'VL  - 5',
    'IS  - 1',
    'SP  - 123',
    'EP  - 130',
    'DO  - 10.1017/ash.2025.2',
    'AN  - 40026775',
    'UR  - https://clinicaltrials.gov/study/NCT00000001',
    'ER  - ',
    '',
    '',
  ])
  expect(getTagValues(getRecord({pubmedId: ' '}), 'AN')).toEqual(['189697998'])
})

test('a DOI loses a leading doi.org url or doi: prefix and is otherwise kept as it is', () => {
  const getDoi = (doi: string) => {
    return getTagValues(getRecord({doi}), 'DO')
  }

  expect(getDoi('https://dx.doi.org/10.1017/ash.2025.2')).toEqual(['10.1017/ash.2025.2'])
  expect(getDoi('http://dx.doi.org/10.1017/ash.2025.2')).toEqual(['10.1017/ash.2025.2'])
  expect(getDoi('https://doi.org/10.1017/ASH.2025.2')).toEqual(['10.1017/ASH.2025.2'])
  expect(getDoi('HTTP://DOI.ORG/10.1017/ash.2025.2')).toEqual(['10.1017/ash.2025.2'])
  expect(getDoi('doi: 10.1017/ash.2025.2')).toEqual(['10.1017/ash.2025.2'])
  expect(getDoi(' 10.1017/ash.2025.2 ')).toEqual(['10.1017/ash.2025.2'])
  expect(getDoi('https://anzctr.org.au/ACTRN12622000715774.aspx')).toEqual([
    'https://anzctr.org.au/ACTRN12622000715774.aspx',
  ])
  expect(getDoi('https://doi.org/')).toEqual([])
  expect(getDoi('')).toEqual([])
})

test('pages split into SP and EP on one hyphen or en dash, otherwise SP alone', () => {
  const getPages = (pages: string) => {
    const record = getRecord({sourceMetadata: {...sourceMetadata, pages}})

    return [getTagValues(record, 'SP'), getTagValues(record, 'EP')]
  }

  expect(getPages('123-130')).toEqual([['123'], ['130']])
  expect(getPages('123–130')).toEqual([['123'], ['130']])
  expect(getPages(' 123 - 30 ')).toEqual([['123'], ['30']])
  expect(getPages('S12-S15')).toEqual([['S12'], ['S15']])
  expect(getPages('e51')).toEqual([['e51'], []])
  expect(getPages('1-2-3')).toEqual([['1-2-3'], []])
  expect(getPages('123-')).toEqual([['123-'], []])
  expect(getPages('')).toEqual([[], []])
  expect(getTagValues(getCitationRecord({ep: '9', pages: '1627-1635', sp: '9'}), 'SP')).toEqual(['1627'])
  expect(getTagValues(getCitationRecord({ep: '110', sp: '100'}), 'EP')).toEqual(['110'])
  expect(getTagValues(getCitationRecord({sp: '100'}), 'EP')).toEqual([])
})

test('every value is trimmed with each whitespace run collapsed to one space and Unicode kept', () => {
  const record = getRecord({
    articleAuthors: ['  Müller,\tJürgen ', 'Ødegård,\r\nÅse'],
    articleSummary: 'First paragraph.\r\n\r\nSecond\tparagraph with α-blockers  and ≥ 2 doses.\n',
    articleTitle: '\n  Effect of β-lactam\r\nallergy labels ',
    sourceMetadata: {...sourceMetadata, journalTitle: 'Journal\nof tests'},
  })

  expect(getTagValues(record, 'TI')).toEqual(['Effect of β-lactam allergy labels'])
  expect(getTagValues(record, 'AU')).toEqual(['Müller, Jürgen', 'Ødegård, Åse'])
  expect(getTagValues(record, 'AB')).toEqual(['First paragraph. Second paragraph with α-blockers and ≥ 2 doses.'])
  expect(getTagValues(record, 'JO')).toEqual(['Journal of tests'])
  expect(getTagValues(getCitationRecord({authors: 'Marra,  AR;  de\nAlmeida SM; ', title: 'A\r\nB'}), 'AU')).toEqual([
    'Marra, AR',
    'de Almeida SM',
  ])
})

test('tags with an empty value are left out of the record', () => {
  const emptyRecord = 'TY  - JOUR\r\nER  - \r\n\r\n'

  expect(
    getComparisonProjectCovidenceExportRisRecord(
      emptyServingRow,
      getArticle({
        articleAuthors: [' '],
        articleSummary: ' ',
        articleTitle: '',
        doi: null,
        pubmedId: null,
        sourceMetadata: null,
      }),
    ),
  ).toBe(emptyRecord)
  expect(getComparisonProjectCovidenceExportRisRecord(emptyServingRow, null)).toBe(emptyRecord)
  expect(getCitationRecord({abstract: null, authors: '', doi: ' ', title: '\n'})).toBe(emptyRecord)
  expect(getComparisonProjectCovidenceExportRisRecord(servingRow, null)).toBe(
    'TY  - JOUR\r\nTI  - Serving title\r\nAB  - Serving summary\r\nER  - \r\n\r\n',
  )
  expect(getTagValues(getRecord({articleTitle: ' '}), 'TI')).toEqual(['Serving title'])
})

test('every line is "XX  - value" ending in CRLF and a record ends with ER and a blank line', () => {
  const records = [
    getRecord(),
    getRecord({covidence: getStoredCovidenceCitation(fullTextReviewCsv, 'csv')}),
    getComparisonProjectCovidenceExportRisRecord(servingRow, null),
  ]

  records.forEach((record) => {
    const lines = getRecordLines(record.slice(0, -'\r\n\r\n'.length))

    expect(record.endsWith('\r\nER  - \r\n\r\n')).toBe(true)
    expect(record.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/u)
    expect(lines[0]).toBe('TY  - JOUR')
    expect(lines.at(-1)).toBe('ER  - ')
    lines.slice(0, -1).forEach((line) => {
      expect(line).toMatch(/^[A-Z][A-Z0-9] {2}- \S(?:.*\S)?$/u)
    })
  })
})

test('records parse back to the same values with the Covidence RIS reader and write the same record again', () => {
  const records = [
    getRecord({articleSummary: 'Line one\nline two', doi: 'https://doi.org/10.1017/ash.2025.2'}),
    getRecord({
      covidence: {
        citation: {
          abstract: 'Citation abstract',
          accession_number: '189697998',
          authors: 'Marra AR; de Almeida SM',
          covidence: '#77',
          doi: 'https://dx.doi.org/10.1086/600000',
          pages: '100-110',
          published_year: '2009',
          title: 'Citation title',
          url: 'https://example.com/citation',
        },
        notes: ['Reviewer A (2026-04-10)(Screen): first'],
        tags: ['Not RCT', 'Possible RCT'],
      },
    }),
    getRecord({covidence: getStoredCovidenceCitation(fullTextReviewCsv, 'csv')}),
  ]
  const parsedRows = getParsedReferenceRows(records.join(''), 'ris')
  const getParsedValues = (row: (typeof parsedRows)[number]) => {
    return {
      abstract: row.citation.abstract ?? null,
      authors: row.citation.authors ?? null,
      doi: row.citation.doi ?? null,
      notes: row.notes,
      pmid: row.citation.pmid ?? null,
      tags: row.tags,
      title: row.citation.title ?? null,
      url: row.citation.url ?? null,
    }
  }
  const getWrittenValues = (record: string) => {
    const [abstract = null] = getTagValues(record, 'AB')
    const [doi = null] = getTagValues(record, 'DO')
    const [notes = null] = getTagValues(record, 'N1')
    const [pmid = null] = getTagValues(record, 'AN')
    const [title = null] = getTagValues(record, 'TI')
    const [url = null] = getTagValues(record, 'UR')

    return {
      abstract,
      authors: getTagValues(record, 'AU').join('; '),
      doi,
      notes,
      pmid,
      tags: getTagValues(record, 'KW'),
      title,
      url,
    }
  }

  expect(parsedRows.map(getParsedValues)).toEqual(records.map(getWrittenValues))
  expect(parsedRows.map(getParsedValues)[0]).toEqual({
    abstract: 'Line one line two',
    authors: 'Abbas, Salma; Aslam, Seemal',
    doi: '10.1017/ash.2025.2',
    notes: null,
    pmid: '40026775',
    tags: [],
    title: 'Article title',
    url: 'https://clinicaltrials.gov/study/NCT00000001',
  })
  expect(parsedRows[1]).toMatchObject({
    citation: {
      abstract: 'Citation abstract',
      authors: 'Marra AR; de Almeida SM',
      doi: '10.1086/600000',
      pmid: '189697998',
      title: 'Citation title',
      url: 'https://example.com/citation',
    },
    notes: 'Reviewer A (2026-04-10)(Screen): first',
    tags: ['Not RCT', 'Possible RCT'],
  })
  expect(
    parsedRows.map((row) => {
      return getRecord({covidence: {citation: row.citation, notes: row.notes ? [row.notes] : [], tags: row.tags}})
    }),
  ).toEqual(records)
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

/*
 * Covidence full-text review RIS, one record per article, for "Import into: Full text review" in Covidence.
 * Every line is "XX  - value" ending in CRLF. Values are trimmed with every run of whitespace, line breaks
 * included, collapsed to one space. Tags whose value is empty are left out. A record ends with "ER  - " and a
 * blank line.
 *
 * Article with a Covidence citation (raw_payload.covidence of its Covidence import route in the compare
 * project's scope): every tag comes from that citation, as Covidence exported it, so Covidence can match the
 * record on re-import. Citation keys are the normalised Covidence CSV headers or the RIS field names of the
 * Covidence import, first non-empty key wins:
 *   TY=JOUR, TI=title, AU=authors split on ";" (one line each), AB=abstract,
 *   PY=first four-digit year in published_year|publication_year|year|publication_date|date,
 *   JO=journal|journal_abbreviation, VL=volume|vl, IS=issue|is,
 *   SP/EP=pages split on a hyphen or en dash, else SP alone; without pages SP=sp and EP=ep,
 *   DO=doi without a leading http(s)://(dx.)doi.org/ or "doi:",
 *   AN=accession_number|pmid, else ref|reference_id when it is 1-8 digits (Covidence exports the PMID of a
 *   PubMed-format import as Ref with an empty Accession Number; 9+ digit values are Embase accession numbers,
 *   which Covidence exports as Accession Number too), UR=url,
 *   KW=covidence.tags and N1=covidence.notes (one line each), ID=covidence|covidence_id|ref|reference_id.
 *
 * Any other article: TY=JOUR, TI=title (else the serving row title), AU=authors (one line each),
 *   AB=summary (else the serving row summary), PY=source metadata publicationYear, JO=journalTitle,
 *   VL=volume, IS=issue, SP/EP=pages split as above, DO=doi without a prefix, AN=PubMed id|accessionNumber,
 *   UR=sourceUrl. No KW, N1 or ID.
 */
import type {ComparisonProjectJudgmentRow} from '../comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'
import type {
  ComparisonProjectCovidenceExportArticle,
  ComparisonProjectCovidenceExportCitation,
} from './comparisonProjectCovidenceExportArticle.ts'

type ComparisonProjectCovidenceExportRisValue = string | null | undefined
type ComparisonProjectCovidenceExportRisField = readonly [tag: string, value: ComparisonProjectCovidenceExportRisValue]
type ComparisonProjectCovidenceExportSourceRow = Pick<ComparisonProjectJudgmentRow, 'articleSummary' | 'articleTitle'>

const risLineBreak = '\r\n'
const risEndOfRecordLine = 'ER  - '
const covidenceAuthorSeparator = /;\s*/u
const covidenceYearKeys = ['published_year', 'publication_year', 'year', 'publication_date', 'date']
const doiPrefixPattern = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)\s*/iu
const pageRangePattern = /^([^\s\-–]+)\s*[-–]\s*([^\s\-–]+)$/u
const pmidPattern = /^\d{1,8}$/u
const yearPattern = /\b\d{4}\b/u

const getRisValue = (value: ComparisonProjectCovidenceExportRisValue) => {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

const getFirstNonEmptyValue = (values: readonly ComparisonProjectCovidenceExportRisValue[]) => {
  return (
    values.map(getRisValue).find((value) => {
      return value !== ''
    }) ?? ''
  )
}

const getYear = (value: ComparisonProjectCovidenceExportRisValue) => {
  return getRisValue(value).match(yearPattern)?.[0] ?? ''
}

const getBareDoi = (doi: ComparisonProjectCovidenceExportRisValue) => {
  return getRisValue(doi).replace(doiPrefixPattern, '')
}

const getPmidShapedValue = (value: ComparisonProjectCovidenceExportRisValue) => {
  const risValue = getRisValue(value)

  return pmidPattern.test(risValue) ? risValue : ''
}

const getRisFields = (
  tag: string,
  values: readonly ComparisonProjectCovidenceExportRisValue[],
): ComparisonProjectCovidenceExportRisField[] => {
  return values.map((value) => {
    return [tag, value]
  })
}

const getPageFields = (pages: ComparisonProjectCovidenceExportRisValue): ComparisonProjectCovidenceExportRisField[] => {
  const pageRange = getRisValue(pages).match(pageRangePattern)

  return pageRange
    ? [
        ['SP', pageRange[1]],
        ['EP', pageRange[2]],
      ]
    : [['SP', pages]]
}

const getCitationValues = (citation: Record<string, string | null>, keys: readonly string[]) => {
  return keys.map((key) => {
    return citation[key]
  })
}

const getCitationValue = (citation: Record<string, string | null>, keys: readonly string[]) => {
  return getFirstNonEmptyValue(getCitationValues(citation, keys))
}

const getCitationPageFields = (citation: Record<string, string | null>): ComparisonProjectCovidenceExportRisField[] => {
  const pages = getCitationValue(citation, ['pages'])
  const startPage = getCitationValue(citation, ['sp'])
  const endPage = getCitationValue(citation, ['ep'])

  return pages === '' && endPage !== ''
    ? [
        ['SP', startPage],
        ['EP', endPage],
      ]
    : getPageFields(pages || startPage)
}

const getCovidenceCitationRisFields = (
  covidence: ComparisonProjectCovidenceExportCitation,
): ComparisonProjectCovidenceExportRisField[] => {
  const {citation} = covidence

  return [
    ['TI', getCitationValue(citation, ['title'])],
    ...getRisFields('AU', getCitationValue(citation, ['authors']).split(covidenceAuthorSeparator)),
    ['AB', getCitationValue(citation, ['abstract'])],
    ['PY', getFirstNonEmptyValue(getCitationValues(citation, covidenceYearKeys).map(getYear))],
    ['JO', getCitationValue(citation, ['journal', 'journal_abbreviation'])],
    ['VL', getCitationValue(citation, ['volume', 'vl'])],
    ['IS', getCitationValue(citation, ['issue', 'is'])],
    ...getCitationPageFields(citation),
    ['DO', getBareDoi(getCitationValue(citation, ['doi']))],
    [
      'AN',
      getFirstNonEmptyValue([
        getCitationValue(citation, ['accession_number', 'pmid']),
        getPmidShapedValue(getCitationValue(citation, ['ref', 'reference_id'])),
      ]),
    ],
    ['UR', getCitationValue(citation, ['url'])],
    ...getRisFields('KW', covidence.tags),
    ...getRisFields('N1', covidence.notes),
    ['ID', getCitationValue(citation, ['covidence', 'covidence_id', 'ref', 'reference_id'])],
  ]
}

const getArticleRisFields = (
  row: ComparisonProjectCovidenceExportSourceRow,
  article: ComparisonProjectCovidenceExportArticle | null,
): ComparisonProjectCovidenceExportRisField[] => {
  const metadata = article?.sourceMetadata ?? null

  return [
    ['TI', getFirstNonEmptyValue([article?.articleTitle, row.articleTitle])],
    ...getRisFields('AU', article?.articleAuthors ?? []),
    ['AB', getFirstNonEmptyValue([article?.articleSummary, row.articleSummary])],
    ['PY', getYear(metadata?.publicationYear?.toString())],
    ['JO', metadata?.journalTitle],
    ['VL', metadata?.volume],
    ['IS', metadata?.issue],
    ...getPageFields(metadata?.pages),
    ['DO', getBareDoi(article?.doi)],
    ['AN', getFirstNonEmptyValue([article?.pubmedId, metadata?.accessionNumber])],
    ['UR', metadata?.sourceUrl],
  ]
}

const getRisLines = (fields: readonly ComparisonProjectCovidenceExportRisField[]) => {
  return fields
    .map(([tag, value]) => {
      return [tag, getRisValue(value)] as const
    })
    .filter(([, value]) => {
      return value !== ''
    })
    .map(([tag, value]) => {
      return `${tag}  - ${value}`
    })
}

export const getComparisonProjectCovidenceExportRisRecord = (
  row: ComparisonProjectCovidenceExportSourceRow,
  article: ComparisonProjectCovidenceExportArticle | null,
) => {
  const fields = article?.covidence
    ? getCovidenceCitationRisFields(article.covidence)
    : getArticleRisFields(row, article)

  return [...getRisLines([['TY', 'JOUR'], ...fields]), risEndOfRecordLine, '', ''].join(risLineBreak)
}

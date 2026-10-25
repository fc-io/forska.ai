/*
 * Covidence full-text review CSV, one row per article, columns in the order of
 * assets/covidence_study/full_text_review.csv.
 *
 * Article with a Covidence citation (raw_payload.covidence of its Covidence import route in the compare
 * project's scope): every column comes from that citation, as Covidence exported it, so Covidence can
 * match the record on re-import. Citation keys are the normalised Covidence headers, RIS aliases after:
 *   Title=title, Authors=authors, Abstract=abstract, Published Year=published_year|publication_year|year,
 *   Published Month=published_month|publication_month|month, Journal=journal, Volume=volume|vl,
 *   Issue=issue|is, Pages=pages, Accession Number=accession_number, DOI=doi, Ref=ref|reference_id,
 *   Covidence #=covidence|covidence_id, Study=study, Notes=covidence.notes and Tags=covidence.tags
 *   joined with "; ".
 *
 * Any other article: Title=title, Authors=authors joined with "; ", Abstract=summary,
 *   Published Year/Month, Journal, Volume, Issue, Pages, Accession Number=article source metadata,
 *   DOI=https://dx.doi.org/<doi>, Ref=PubMed id, Covidence #=empty,
 *   Study=first author surname (text before the comma, else first word, spaces removed) + " " + year
 *   when both exist, Notes=empty, Tags=empty.
 */
import type {ComparisonProjectJudgmentRow} from '../comparisonProjectJudgmentRows/comparisonProjectJudgmentRowsTypes.ts'
import type {
  ComparisonProjectCovidenceExportArticle,
  ComparisonProjectCovidenceExportCitation,
} from './comparisonProjectCovidenceExportArticle.ts'

export const comparisonProjectCovidenceExportHeaders = [
  'Title',
  'Authors',
  'Abstract',
  'Published Year',
  'Published Month',
  'Journal',
  'Volume',
  'Issue',
  'Pages',
  'Accession Number',
  'DOI',
  'Ref',
  'Covidence #',
  'Study',
  'Notes',
  'Tags',
] as const

type ComparisonProjectCovidenceExportHeader = (typeof comparisonProjectCovidenceExportHeaders)[number]
type ComparisonProjectCovidenceExportCsvValues = Record<ComparisonProjectCovidenceExportHeader, string>
type ComparisonProjectCovidenceExportSourceRow = Pick<ComparisonProjectJudgmentRow, 'articleSummary' | 'articleTitle'>

const covidenceExportListSeparator = '; '

const getCitationValue = (citation: Record<string, string | null>, keys: readonly string[]) => {
  return (
    keys
      .map((key) => {
        return citation[key] ?? null
      })
      .find((value): value is string => {
        return value !== null
      }) ?? ''
  )
}

const getCovidenceCitationCsvValues = (
  covidence: ComparisonProjectCovidenceExportCitation,
): ComparisonProjectCovidenceExportCsvValues => {
  const {citation} = covidence

  return {
    Title: getCitationValue(citation, ['title']),
    Authors: getCitationValue(citation, ['authors']),
    Abstract: getCitationValue(citation, ['abstract']),
    'Published Year': getCitationValue(citation, ['published_year', 'publication_year', 'year']),
    'Published Month': getCitationValue(citation, ['published_month', 'publication_month', 'month']),
    Journal: getCitationValue(citation, ['journal']),
    Volume: getCitationValue(citation, ['volume', 'vl']),
    Issue: getCitationValue(citation, ['issue', 'is']),
    Pages: getCitationValue(citation, ['pages']),
    'Accession Number': getCitationValue(citation, ['accession_number']),
    DOI: getCitationValue(citation, ['doi']),
    Ref: getCitationValue(citation, ['ref', 'reference_id']),
    'Covidence #': getCitationValue(citation, ['covidence', 'covidence_id']),
    Study: getCitationValue(citation, ['study']),
    Notes: covidence.notes.join(covidenceExportListSeparator),
    Tags: covidence.tags.join(covidenceExportListSeparator),
  }
}

const getFirstAuthorSurname = (author: string | undefined) => {
  const trimmedAuthor = author?.trim() ?? ''
  const commaIndex = trimmedAuthor.indexOf(',')
  const surname = commaIndex === -1 ? (trimmedAuthor.split(/\s+/u)[0] ?? '') : trimmedAuthor.slice(0, commaIndex)

  return surname.replace(/\s+/gu, '')
}

const getStudyValue = (firstAuthor: string | undefined, publishedYear: string) => {
  const surname = getFirstAuthorSurname(firstAuthor)

  return surname !== '' && publishedYear !== '' ? `${surname} ${publishedYear}` : ''
}

const getDoiUrl = (doi: string | null) => {
  const trimmedDoi = doi?.trim() ?? ''

  return trimmedDoi === '' ? '' : `https://dx.doi.org/${trimmedDoi}`
}

const getArticleCsvValues = (
  row: ComparisonProjectCovidenceExportSourceRow,
  article: ComparisonProjectCovidenceExportArticle | null,
): ComparisonProjectCovidenceExportCsvValues => {
  const metadata = article?.sourceMetadata ?? null
  const authors = article?.articleAuthors ?? []
  const publishedYear = metadata?.publicationYear === undefined ? '' : String(metadata.publicationYear)

  return {
    Title: article?.articleTitle?.trim() || row.articleTitle?.trim() || '',
    Authors: authors.join(covidenceExportListSeparator),
    Abstract: article?.articleSummary ?? row.articleSummary ?? '',
    'Published Year': publishedYear,
    'Published Month': metadata?.publicationMonth ?? '',
    Journal: metadata?.journalTitle ?? '',
    Volume: metadata?.volume ?? '',
    Issue: metadata?.issue ?? '',
    Pages: metadata?.pages ?? '',
    'Accession Number': metadata?.accessionNumber ?? '',
    DOI: getDoiUrl(article?.doi ?? null),
    Ref: article?.pubmedId?.trim() ?? '',
    'Covidence #': '',
    Study: getStudyValue(authors[0], publishedYear),
    Notes: '',
    Tags: '',
  }
}

export const getComparisonProjectCovidenceExportCsvValues = (
  row: ComparisonProjectCovidenceExportSourceRow,
  article: ComparisonProjectCovidenceExportArticle | null,
) => {
  const values = article?.covidence
    ? getCovidenceCitationCsvValues(article.covidence)
    : getArticleCsvValues(row, article)

  return comparisonProjectCovidenceExportHeaders.map((header) => {
    return values[header]
  })
}

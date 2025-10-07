import {type} from 'arktype'
import {XMLParser} from 'fast-xml-parser'

import type {DatabaseEntry} from '../pubmedWorkflowStoreEntries.ts'

const DateRevised = type({Year: 'number', Month: 'number', Day: 'number'})

const PubDate = type({Year: 'number', Month: 'string', Day: 'number'})

const JournalIssue = type({Volume: 'number', Issue: 'number', PubDate: PubDate})

const Journal = type({ISSN: 'string', JournalIssue: JournalIssue, Title: 'string', ISOAbbreviation: 'string'})

const Pagination = type({StartPage: 'number', MedlinePgn: 'number'})

const Abstract = type({AbstractText: 'string', CopyrightInformation: 'string'})

const AffiliationInfo = type({Affiliation: 'string'})

const Author = type({LastName: 'string', ForeName: 'string', Initials: 'string', AffiliationInfo: AffiliationInfo})

const AuthorList = type({Author: Author.array()})

const PublicationTypeList = type({PublicationType: 'string'})

const ArticleDate = type({Year: 'number', Month: 'number', Day: 'number'})

const Article = type({
  Journal: Journal,
  ArticleTitle: 'string',
  Pagination: Pagination,
  ELocationID: 'unknown[]',
  Abstract: Abstract,
  AuthorList: AuthorList,
  Language: 'string',
  PublicationTypeList: PublicationTypeList,
  ArticleDate: ArticleDate,
})

const MedlineJournalInfo = type({Country: 'string', MedlineTA: 'string', NlmUniqueID: 'number', ISSNLinking: 'string'})

const KeywordList = type({Keyword: 'string[]'})

const MedlineCitation = type({
  PMID: 'number',
  DateRevised: DateRevised,
  Article: Article,
  MedlineJournalInfo: MedlineJournalInfo,
  CitationSubset: 'string',
  KeywordList: KeywordList,
  CoiStatement: 'string',
})

const PubMedPubDate = type({Year: 'number', Month: 'number', Day: 'number', 'Hour?': 'number', 'Minute?': 'number'})

const History = type({PubMedPubDate: PubMedPubDate.array()})

const ArticleIdList = type({ArticleId: 'unknown[]'})

const Citation = type({'i?': 'string', 'b?': 'number', '#text': 'string'})

const Reference = type({Citation: Citation})

const ReferenceList = type({Reference: Reference.array()})

const PubmedData = type({
  History: History,
  PublicationStatus: 'string',
  ArticleIdList: ArticleIdList,
  ReferenceList: ReferenceList,
})

const PubmedArticle = type({MedlineCitation: MedlineCitation, PubmedData: PubmedData})

const PubmedArticleSet = type({PubmedArticle: 'unknown | unknown[]'})

const PubmedDocument = type({'?xml': 'string', PubmedArticleSet: PubmedArticleSet})

type PubmedDocumentType = typeof PubmedDocument.infer

const parser = new XMLParser({ignoreAttributes: true})

const toIsoDate = (y?: number, m?: number | string, d?: number): string => {
  const year = y ?? 1970
  const monthNum = typeof m === 'string' ? Date.parse(`${m} 1, ${year}`) : undefined
  const month = typeof m === 'number' ? m : monthNum ? new Date(monthNum).getMonth() + 1 : 1
  const day = d ?? 1
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}T00:00:00.000Z`
}

const extractAbstract = (abs: unknown): string => {
  if (!abs) return ''
  if (typeof abs === 'string') return abs
  if (typeof abs === 'object' && abs !== null) {
    const a = abs as Record<string, unknown>
    const at = a.AbstractText
    if (typeof at === 'string') return at
    if (Array.isArray(at)) {
      return at
        .map((x) => {
          if (typeof x === 'string') return x
          if (typeof x === 'object' && x !== null) {
            const xo = x as Record<string, unknown>
            return typeof xo['#text'] === 'string' ? xo['#text'] : JSON.stringify(x)
          }
          return String(x)
        })
        .join(' ')
    }
    if (typeof at === 'object' && at !== null) {
      const t = (at as Record<string, unknown>)['#text']
      return typeof t === 'string' ? t : ''
    }
  }
  return ''
}

const extractAuthors = (authList: unknown): string[] => {
  if (!authList || typeof authList !== 'object') return []
  const a = authList as Record<string, unknown>
  const list = a.Author
  const toName = (obj: unknown): string => {
    if (typeof obj === 'object' && obj !== null) {
      const o = obj as Record<string, unknown>
      const ln = typeof o.LastName === 'string' ? o.LastName : ''
      const fn = typeof o.ForeName === 'string' ? o.ForeName : ''
      const init = typeof o.Initials === 'string' ? o.Initials : ''
      return fn || ln ? `${fn} ${ln}`.trim() : init
    }
    return typeof obj === 'string' ? obj : ''
  }
  if (Array.isArray(list)) return list.map(toName).filter(Boolean)
  if (list) return [toName(list)].filter(Boolean)
  return []
}

const pubmedHarvestGetParsedXML = async (responseData: unknown, importRoute: string): Promise<DatabaseEntry[]> => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const root = parser.parse(responseData as string)
  const result: DatabaseEntry[] = []
  try {
    const parsedRoot = PubmedDocument.assert(root)
    const artsRaw = parsedRoot.PubmedArticleSet?.PubmedArticle
    const arts = Array.isArray(artsRaw) ? artsRaw : artsRaw ? [artsRaw] : []

    for (const item of arts) {
      try {
        const art = PubmedArticle.assert(item)
        const cite = art.MedlineCitation
        const article = cite.Article
        const pmidNum = cite.PMID
        const pmid = String(pmidNum)
        const title = article.ArticleTitle
        const abstract = extractAbstract(article.Abstract)
        const authors = extractAuthors(article.AuthorList)
        const createdAt = article.ArticleDate
          ? toIsoDate(article.ArticleDate.Year, article.ArticleDate.Month, article.ArticleDate.Day)
          : toIsoDate(cite.DateRevised?.Year, cite.DateRevised?.Month, cite.DateRevised?.Day)
        const updatedAt = cite.DateRevised
          ? toIsoDate(cite.DateRevised.Year, cite.DateRevised.Month, cite.DateRevised.Day)
          : createdAt

        result.push({
          article_id: `pmid:${pmid}`,
          article_title: title,
          article_summary: abstract,
          article_authors: authors,
          article_created_at: createdAt,
          article_updated_at: updatedAt,
          article_version: '1',
          pubmed_id: pmid,
          import_route: importRoute,
        })
      } catch (e) {
        // Skip invalid item; continue
      }
    }
  } catch (e) {
    // If strict schema fails, try a looser parse path without throwing
    const set = (root && root.PubmedArticleSet && root.PubmedArticleSet.PubmedArticle) || []
    const arts = Array.isArray(set) ? set : set ? [set] : []
    for (const it of arts) {
      const pmid = String(it?.MedlineCitation?.PMID ?? '')
      if (!pmid) continue
      const title = it?.MedlineCitation?.Article?.ArticleTitle ?? ''
      const abstract = extractAbstract(it?.MedlineCitation?.Article?.Abstract)
      const authors = extractAuthors(it?.MedlineCitation?.Article?.AuthorList)
      const dr = it?.MedlineCitation?.DateRevised
      const ad = it?.MedlineCitation?.Article?.ArticleDate
      const createdAt = ad ? toIsoDate(ad.Year, ad.Month, ad.Day) : toIsoDate(dr?.Year, dr?.Month, dr?.Day)
      const updatedAt = dr ? toIsoDate(dr.Year, dr.Month, dr.Day) : createdAt
      result.push({
        article_id: `pmid:${pmid}`,
        article_title: String(title),
        article_summary: abstract,
        article_authors: authors,
        article_created_at: createdAt,
        article_updated_at: updatedAt,
        article_version: '1',
        pubmed_id: pmid,
        import_route: importRoute,
      })
    }
  }
  return result
}

export {PubmedDocument, type PubmedDocumentType, pubmedHarvestGetParsedXML}

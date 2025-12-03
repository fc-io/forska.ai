import {type} from 'arktype'
import {XMLParser} from 'fast-xml-parser'

import {articles as articlesSchema} from '../../db/schema.ts'

type ArticleInsert = typeof articlesSchema.$inferInsert

type ArticlesUpsertPayload = {
  article_id: string
  article_title: NonNullable<ArticleInsert['articleTitle']>
  article_summary: string
  article_authors: NonNullable<ArticleInsert['articleAuthors']>
  article_updated_at: string
  article_created_at: string
  article_version: string
  pubmed_id: string
  import_route: NonNullable<ArticleInsert['importRoute']>
}
const DateRevised = type({Year: 'string | number', Month: 'string | number', Day: 'string | number'})
const PubDate = type({Year: 'string | number', Month: 'string | number', Day: 'string | number'})
const JournalIssue = type({Volume: 'string | number', Issue: 'string | number', PubDate: PubDate})
const Journal = type({'ISSN?': 'string', JournalIssue: JournalIssue, Title: 'string', 'ISOAbbreviation?': 'string'})
const Pagination = type({StartPage: 'string | number', MedlinePgn: 'string | number'})
const Author = type({
  'LastName?': 'string',
  'ForeName?': 'string',
  'Initials?': 'string',
  'AffiliationInfo?': 'unknown',
})

const AuthorList = type({Author: Author.or(Author.array())})
const PublicationTypeList = type({PublicationType: 'unknown'})
const ArticleDate = type({Year: 'string | number', Month: 'string | number', Day: 'string | number'})
const Article = type({
  Journal: Journal,
  ArticleTitle: 'unknown',
  'Pagination?': Pagination,
  ELocationID: 'unknown',
  'Abstract?': 'unknown',
  'AuthorList?': AuthorList,
  'Language?': 'string',
  'PublicationTypeList?': PublicationTypeList,
  'ArticleDate?': ArticleDate,
})

const MedlineJournalInfo = type({
  'Country?': 'string',
  'MedlineTA?': 'string',
  'NlmUniqueID?': 'string | number',
  'ISSNLinking?': 'string',
})

const KeywordList = type({Keyword: 'string | string[]'})

const MedlineCitation = type({
  PMID: 'string | number',
  'DateRevised?': DateRevised,
  Article: Article,
  'MedlineJournalInfo?': MedlineJournalInfo,
  'CitationSubset?': 'string',
  'KeywordList?': KeywordList,
  'CoiStatement?': 'string',
})

const PubMedPubDate = type({
  Year: 'string | number',
  Month: 'string | number',
  Day: 'string | number',
  'Hour?': 'string | number',
  'Minute?': 'string | number',
})

const History = type({PubMedPubDate: PubMedPubDate.or(PubMedPubDate.array())})
const ArticleIdList = type({ArticleId: 'unknown'})
// Some PubMed records serialize <Citation> as plain text, others as
// an object with nested inline tags (e.g., <i>, <b>) that map to
// properties and a consolidated '#text'. Accept both forms.
const CitationText = type('string')
const CitationObject = type({'i?': 'string', 'b?': 'string | number', '#text': 'string'})
const Citation = CitationText.or(CitationObject)
const Reference = type({Citation: Citation})
const ReferenceList = type({Reference: Reference.or(Reference.array())})
const PubmedData = type({
  'History?': History,
  'PublicationStatus?': 'string',
  'ArticleIdList?': ArticleIdList,
  'ReferenceList?': ReferenceList,
})

const PubmedArticle = type({MedlineCitation: MedlineCitation, 'PubmedData?': PubmedData})
const PubmedArticleSet = type({PubmedArticle: 'unknown'})
const PubmedDocument = type({PubmedArticleSet: PubmedArticleSet})

type PubmedDocumentType = typeof PubmedDocument.infer

const parser = new XMLParser({ignoreAttributes: true})

const toIsoDate = (y?: number | string, m?: number | string, d?: number | string): string => {
  const toInt = (v: unknown): number | undefined => {
    if (typeof v === 'number') return v
    if (typeof v === 'string') {
      const n = Number.parseInt(v, 10)
      return Number.isNaN(n) ? undefined : n
    }
    return undefined
  }

  const year = toInt(y) ?? 1970

  const month = (() => {
    if (typeof m === 'number') return m
    if (typeof m === 'string') {
      const asNum = toInt(m)
      if (asNum && asNum >= 1 && asNum <= 12) return asNum
      const parsed = Date.parse(`${m} 1, ${year}`)
      return Number.isNaN(parsed) ? 1 : new Date(parsed).getMonth() + 1
    }
    return 1
  })()

  const day = toInt(d) ?? 1
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

const readArticlesArray = (maybeArray: unknown): unknown[] => {
  if (Array.isArray(maybeArray)) return maybeArray
  return maybeArray ? [maybeArray] : []
}

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

const readDatePart = (value: unknown): string | number | undefined => {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

const parseXml = (input: unknown): unknown => {
  const xml = typeof input === 'string' ? input : String(input ?? '')
  return parser.parse(xml) as unknown
}

const extractTitle = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractTitle).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const t = obj['#text']
    if (typeof t === 'string') return t
    const collected = Object.values(obj)
      .map((v) => {
        if (typeof v === 'string') return v
        if (typeof v === 'object' && v !== null) {
          const vt = (v as Record<string, unknown>)['#text']
          return typeof vt === 'string' ? vt : ''
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
    return collected
  }
  return ''
}

const buildPayload = (it: unknown, importRoute: string): ArticlesUpsertPayload | undefined => {
  const medline = toRecord(toRecord(it)?.MedlineCitation)
  if (!medline) return undefined

  const pmidRaw = medline.PMID
  const pmid = typeof pmidRaw === 'number' ? String(pmidRaw) : typeof pmidRaw === 'string' ? pmidRaw : ''
  if (!pmid) return undefined

  const article = toRecord(medline.Article) ?? {}
  const title = article.ArticleTitle ?? ''
  const abstract = extractAbstract(article.Abstract)
  const authors = extractAuthors(article.AuthorList)
  const dr = toRecord(medline.DateRevised)
  const ad = toRecord(article.ArticleDate)
  const createdAt = ad
    ? toIsoDate(readDatePart(ad.Year), readDatePart(ad.Month), readDatePart(ad.Day))
    : toIsoDate(readDatePart(dr?.Year), readDatePart(dr?.Month), readDatePart(dr?.Day))
  const updatedAt = dr
    ? toIsoDate(readDatePart(dr.Year), readDatePart(dr.Month), readDatePart(dr.Day))
    : createdAt

  return {
    article_id: `pmid:${pmid}`,
    article_title: extractTitle(title),
    article_summary: abstract,
    article_authors: authors,
    article_created_at: createdAt,
    article_updated_at: updatedAt,
    article_version: '1',
    pubmed_id: pmid,
    import_route: importRoute,
  }
}

const pubmedHarvestGetParsedXML = async (
  responseData: unknown,
  importRoute: string,
): Promise<ArticlesUpsertPayload[]> => {
  const root = parseXml(responseData)
  const doc = PubmedDocument(root)
  const results: ArticlesUpsertPayload[] = []

  if (!(doc instanceof type.errors)) {
    const arts = readArticlesArray(doc.PubmedArticleSet?.PubmedArticle)
    const payloads = arts
      .map((item) => {
        const parsed = PubmedArticle(item)
        return parsed instanceof type.errors ? buildPayload(item, importRoute) : buildPayload(parsed, importRoute)
      })
      .filter((x): x is ArticlesUpsertPayload => {
        return Boolean(x)
      })
    return payloads
  }

  const set = toRecord(root)?.PubmedArticleSet
  const arts = readArticlesArray(toRecord(set)?.PubmedArticle)
  for (const it of arts) {
    const payload = buildPayload(it, importRoute)
    if (payload) results.push(payload)
  }
  return results
}

export {PubmedDocument, type PubmedDocumentType, pubmedHarvestGetParsedXML}

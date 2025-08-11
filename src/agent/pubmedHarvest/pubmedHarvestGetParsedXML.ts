import {type} from 'arktype'
import {XMLParser} from 'fast-xml-parser'

const DateRevised = type({Year: 'number', Month: 'number', Day: 'number'})

const PubDate = type({Year: 'number', Month: 'string', Day: 'number'})

const JournalIssue = type({Volume: 'number', Issue: 'number', PubDate: PubDate})

const Journal = type({
  ISSN: 'string',
  JournalIssue: JournalIssue,
  Title: 'string',
  ISOAbbreviation: 'string',
})

const Pagination = type({StartPage: 'number', MedlinePgn: 'number'})

const Abstract = type({AbstractText: 'string', CopyrightInformation: 'string'})

const AffiliationInfo = type({Affiliation: 'string'})

const Author = type({
  LastName: 'string',
  ForeName: 'string',
  Initials: 'string',
  AffiliationInfo: AffiliationInfo,
})

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

const MedlineJournalInfo = type({
  Country: 'string',
  MedlineTA: 'string',
  NlmUniqueID: 'number',
  ISSNLinking: 'string',
})

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

const PubMedPubDate = type({
  Year: 'number',
  Month: 'number',
  Day: 'number',
  'Hour?': 'number',
  'Minute?': 'number',
})

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

const PubmedArticle = type({
  MedlineCitation: MedlineCitation,
  PubmedData: PubmedData,
})

const PubmedArticleSet = type({PubmedArticle: PubmedArticle})

const PubmedDocument = type({
  '?xml': 'string',
  PubmedArticleSet: PubmedArticleSet,
})

type PubmedDocumentType = typeof PubmedDocument.infer

const parser = new XMLParser({ignoreAttributes: true})

const pubmedHarvestGetParsedXML = async (responseData: unknown) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const root = parser.parse(responseData as string)
    const parsedRoot = PubmedDocument.assert(root)

    parsedRoot.PubmedArticleSet?.PubmedArticle || []

    //   for (const art of Array.isArray(arts) ? arts : [arts]) {
    //     const cite = art.MedlineCitation?.Article ?? {}
    //     const pmid = art.MedlineCitation?.PMID ?? ''
    //     const title = cite.ArticleTitle ?? ''
    //     const absObj = cite.Abstract?.AbstractText
    //     const absTxt = Array.isArray(absObj)
    //       ? absObj
    //           .map((x: any) => {
    //             return x['#text'] ?? x
    //           })
    //           .join(' ')
    //       : (absObj?.['#text'] ?? absObj ?? '')
    //     output.push({pmid, title, abstract: absTxt})
    //   }
    //   return page(ret + PAGE) // tail call – no stack growth
  } catch (error) {
    console.error('Error parsing PubMed XML:', error)
    throw error
  }
}

export {PubmedDocument, type PubmedDocumentType, pubmedHarvestGetParsedXML}

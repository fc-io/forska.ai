import {createHash} from 'node:crypto'

import {type} from 'arktype'

import type {ArticleImportStoreRow} from '../server/services/articleImportStoreService.ts'
import {withDataSourceImportPageRetry} from '../server/services/dataSourceImportRetry.ts'
import type {DataSourceImportPageProgress} from '../server/services/dataSourceImportStateRepository.ts'
import {normalizeDoiIdentifier} from '../utils/articleIdentifierNormalization.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {
  type EuropePmcFetchedPage,
  type EuropePmcPageRequest,
  fetchEuropePmcSearchJson,
  walkEuropePmcCursorPages,
} from './europePmcCursorWalk.ts'
import {pubmedHarvestGetIdParams} from './pubmedHarvest/pubmedHarvestGetIdParams.ts'
import {
  type DatabaseEntry as PubmedWorkflowDatabaseEntry,
  pubmedWorkflowStoreEntries,
} from './pubmedWorkflowStoreEntries.ts'

const EuropePmcAuthor = type({
  'fullName?': 'string',
  'firstName?': 'string',
  'lastName?': 'string',
  'initials?': 'string',
  'collectiveName?': 'string',
})
const EuropePmcAuthorList = type({'author?': EuropePmcAuthor.or(EuropePmcAuthor.array())})
const EuropePmcFullTextUrl = type({
  'availability?': 'string',
  'availabilityCode?': 'string',
  'documentStyle?': 'string',
  'site?': 'string',
  'url?': 'string',
})
const EuropePmcFullTextUrlList = type({'fullTextUrl?': EuropePmcFullTextUrl.or(EuropePmcFullTextUrl.array())})
const EuropePmcItem = type({
  'id?': 'string | number',
  source: 'string',
  'pmid?': 'string | number',
  'doi?': 'string',
  'title?': 'unknown',
  'authorString?': 'string',
  'authorList?': EuropePmcAuthorList,
  'abstractText?': 'string',
  'journalTitle?': 'string',
  'journalInfo?': 'unknown',
  'fullTextUrlList?': EuropePmcFullTextUrlList,
  'firstPublicationDate?': 'string',
  'pubYear?': 'string | number',
  'pubMonth?': 'string | number',
  'pubDay?': 'string | number',
})

const EuropePmcRequest = type({
  queryString: 'string',
  resultType: 'string',
  'cursorMark?': 'string',
  'pageSize?': 'number | string',
  'sort?': 'string',
  'synonym?': 'boolean',
})

const EuropePmcResultList = type({'result?': EuropePmcItem.or(EuropePmcItem.array())})

const EuropePmcResponse = type({
  'version?': 'string | number',
  'hitCount?': 'string | number',
  'resultList?': EuropePmcResultList,
  'nextCursorMark?': 'string',
  'nextPageUrl?': 'string',
  'request?': EuropePmcRequest,
})
type HarvestOptions = {
  cursor?: string | null
  dataSourceId?: string
  onCursorUpdate?: (cursor: string | null, progress?: DataSourceImportPageProgress) => Promise<void>
}
export type PubmedHarvestPage = {
  cursorBefore: string
  cursorAfter: string | null
  pageIndex: number
  rawPage: unknown
  rawItems: (typeof EuropePmcItem.infer)[]
  workflowEntries: PubmedWorkflowDatabaseEntry[]
  normalizedRecords: ArticleImportStoreRow[]
  sourceRecordCount: number
  sourceRecordHash: string
  hitCount: number
  fetchedCount: number
  importedCount: number
}
type PubmedHarvestPageCallback = (page: PubmedHarvestPage) => Promise<void> | void
type PubmedHarvestPagesInput = InputData & {
  cursor?: string | null
  dataSourceId?: string
  onPage: PubmedHarvestPageCallback
}

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

const toIsoFromDateString = (date?: string): string => {
  if (!date) return toIsoDate()
  const parts = date.split('-')
  if (parts.length === 3) return `${parts[0]}-${parts[1]}-${parts[2]}T00:00:00.000Z`
  if (parts.length === 2) return toIsoDate(parts[0] as unknown as number, parts[1] as unknown as number, 1)
  return toIsoDate(Number.parseInt(parts[0] ?? '1970', 10), 1, 1)
}

const readArray = <T>(x: T | T[] | undefined): T[] => {
  return Array.isArray(x) ? x : x ? [x] : []
}

const logMissingIds = (items: (typeof EuropePmcItem.infer)[], i = 0): void => {
  const current = items[i]
  if (current) {
    const hasId = typeof current.id === 'string' || typeof current.id === 'number'
    if (!hasId) {
      console.log('Europe PMC item missing id. Full item:', current)
    }
    logMissingIds(items, i + 1)
  }
}

const extractAuthors = (item: typeof EuropePmcItem.infer): string[] => {
  const list = item.authorList?.author
  if (list) {
    const arr = readArray(list)
    return arr
      .map((a) => {
        if (typeof a.fullName === 'string' && a.fullName.trim()) return a.fullName
        const ln = typeof a.lastName === 'string' ? a.lastName.trim() : ''
        const initials = typeof a.initials === 'string' ? a.initials.trim() : ''
        const fn = typeof a.firstName === 'string' ? a.firstName.trim() : ''
        const collective = typeof a.collectiveName === 'string' ? a.collectiveName.trim() : ''
        if (ln && initials) return `${ln} ${initials}`
        if (fn && ln) return `${fn} ${ln}`
        return collective || ln || fn || ''
      })
      .filter(Boolean)
  }
  const s = item.authorString
  if (!s) return []
  return s
    .split(',')
    .map((x) => {
      return x.trim()
    })
    .filter(Boolean)
}

const extractTitle = (t: unknown): string => {
  if (!t) return ''
  if (typeof t === 'string') return t
  if (typeof t === 'object' && t !== null) {
    const v = (t as Record<string, unknown>)['#text']
    return typeof v === 'string' ? v : ''
  }
  return ''
}

const normalizeDoi = (value: unknown): string | undefined => {
  const outcome = normalizeDoiIdentifier(value)

  return outcome.status === 'accepted' ? outcome.identifier.normalizedValue : undefined
}

const buildQuery = (from: string, to: string): string => {
  const a = from.replaceAll('/', '-')
  const b = to.replaceAll('/', '-')
  return `SRC:MED AND FIRST_PDATE:[${a} TO ${b}]`
}

const fetchEuropePmc = async (
  request: EuropePmcPageRequest,
): Promise<EuropePmcFetchedPage<typeof EuropePmcItem.infer>> => {
  const json = await fetchEuropePmcSearchJson(request)
  const parsed = EuropePmcResponse(json)
  if (parsed instanceof type.errors) {
    console.error('Invalid response from Europe PMC. Raw JSON:', JSON.stringify(json, null, 2))
    throw new Error(parsed.join('\n'))
  }
  console.log('hitCount', parsed.hitCount)
  const items = readArray(parsed.resultList?.result)
  logMissingIds(items)
  const hitCount = (() => {
    if (typeof parsed.hitCount === 'number') return parsed.hitCount
    if (typeof parsed.hitCount === 'string') {
      const n = Number.parseInt(parsed.hitCount, 10)
      return Number.isNaN(n) ? items.length : n
    }
    return items.length
  })()
  const nextCursor = parsed.nextCursorMark
  return {items, nextCursor, hitCount, rawPage: json}
}

const toDatabaseEntry = (it: typeof EuropePmcItem.infer, importRoute: string) => {
  const pmidRaw = (typeof it.pmid === 'number' || typeof it.pmid === 'string') && it.pmid ? it.pmid : it.id
  const pmid = typeof pmidRaw === 'number' ? String(pmidRaw) : String(pmidRaw)
  const createdAt = it.firstPublicationDate
    ? toIsoFromDateString(it.firstPublicationDate)
    : toIsoDate(it.pubYear, it.pubMonth, it.pubDay)
  const doi = normalizeDoi(it.doi)
  return {
    article_id: `pmid:${pmid}`,
    article_title: extractTitle(it.title),
    article_summary: it.abstractText ?? '',
    article_authors: extractAuthors(it),
    article_created_at: createdAt,
    article_updated_at: createdAt,
    article_version: '1',
    ...(doi ? {doi} : {}),
    pubmed_id: pmid,
    import_route: importRoute,
    original_data: it,
  }
}

export const pubmedHarvestToDatabaseEntry = toDatabaseEntry

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

const getStableJsonValue = (value: unknown): string => {
  return value instanceof Date
    ? JSON.stringify(value.toISOString())
    : Array.isArray(value)
      ? `[${value
          .map((entry) => {
            return getStableJsonValue(entry)
          })
          .join(',')}]`
      : isObjectRecord(value)
        ? `{${Object.keys(value)
            .sort((left, right) => {
              return left.localeCompare(right)
            })
            .map((key) => {
              return `${JSON.stringify(key)}:${getStableJsonValue(value[key])}`
            })
            .join(',')}}`
        : (JSON.stringify(value) ?? 'null')
}

const getSourceRecordHash = (value: unknown): string => {
  return createHash('sha256').update(getStableJsonValue(value)).digest('hex')
}

const getSourceRecordHashPayload = (row: ArticleImportStoreRow, rawPayload: unknown) => {
  return (
    rawPayload ?? {
      articleAuthors: row.articleAuthors,
      articleId: row.articleId,
      articleSummary: row.articleSummary,
      articleTitle: row.articleTitle,
      articleUpdatedAt: row.articleUpdatedAt,
      doi: row.doi,
      publicationStatus: row.publicationStatus,
      pubmedId: row.pubmedId,
      sourceMetadata: row.sourceMetadata,
      url: row.url,
    }
  )
}

const toArticleImportStoreRow = (entry: PubmedWorkflowDatabaseEntry): ArticleImportStoreRow => {
  const row: ArticleImportStoreRow = {
    articleId: entry.article_id,
    articleTitle: entry.article_title,
    articleSummary: entry.article_summary,
    articleAuthors: entry.article_authors,
    articleUpdatedAt: new Date(entry.article_updated_at),
    articleCreatedAt: new Date(entry.article_created_at),
    articleVersion: Number.parseInt(entry.article_version, 10),
    doi: entry.doi,
    pubmedId: entry.pubmed_id,
    originalData: entry.original_data,
    importRoute: entry.import_route,
  }
  const rawPayload = row.originalData ?? null

  return {
    ...row,
    externalArticleId: row.articleId,
    rawPayload,
    sourceRecordKey: row.articleId,
    sourceRecordHash: getSourceRecordHash(getSourceRecordHashPayload(row, rawPayload)),
  }
}

const hasAnyId = (it: typeof EuropePmcItem.infer) => {
  const hasPmid = (typeof it.pmid === 'number' || typeof it.pmid === 'string') && String(it.pmid).length > 0
  const hasId = (typeof it.id === 'number' || typeof it.id === 'string') && String(it.id).length > 0
  return hasPmid || hasId
}

export const fetchPubmedHarvestPages = async (
  input: PubmedHarvestPagesInput,
): Promise<{fetchedTotal: number; pageCount: number}> => {
  const idParams = pubmedHarvestGetIdParams(input)
  const sp = idParams.searchParams

  return await walkEuropePmcCursorPages({
    cursor: input.cursor,
    dataSourceId: input.dataSourceId,
    fetchPage: fetchEuropePmc,
    fromDate: input.fromDate,
    importRoute: input.importRoute,
    isImportable: hasAnyId,
    onPage: async (page) => {
      const workflowEntries = page.importableItems.map((it) => {
        return toDatabaseEntry(it, input.importRoute)
      })
      const normalizedRecords = workflowEntries.map((entry) => {
        return toArticleImportStoreRow(entry)
      })

      await input.onPage({
        cursorBefore: page.cursorBefore,
        cursorAfter: page.cursorAfter,
        pageIndex: page.pageIndex,
        rawPage: page.rawPage,
        rawItems: page.items,
        workflowEntries,
        normalizedRecords,
        sourceRecordCount: normalizedRecords.length,
        sourceRecordHash: getSourceRecordHash(page.rawPage),
        hitCount: page.hitCount,
        fetchedCount: page.fetchedCount,
        importedCount: page.importedCount,
      })
    },
    query: buildQuery(sp.mindate, sp.maxdate),
    toDate: input.toDate,
  })
}

const pubmedHarvest = async (input: InputData & HarvestOptions): Promise<void> => {
  console.log('Europe PMC harvest start', input)
  const {fetchedTotal} = await fetchPubmedHarvestPages({
    fromDate: input.fromDate,
    toDate: input.toDate,
    importRoute: input.importRoute,
    cursor: input.cursor,
    dataSourceId: input.dataSourceId,
    onPage: async (page) => {
      await withDataSourceImportPageRetry(`PubMed page ${page.pageIndex + 1}`, async () => {
        if (page.workflowEntries.length > 0) {
          await pubmedWorkflowStoreEntries(page.workflowEntries)
        }
        if (input.onCursorUpdate) {
          await input.onCursorUpdate(page.cursorAfter, {
            fetchedCount: page.rawItems.length,
            pageKey: page.cursorBefore,
            storedCount: page.workflowEntries.length,
            totalCount: page.hitCount,
          })
        }
      })
    },
  })
  console.log(`Europe PMC harvest complete. Fetched ${fetchedTotal} articles.`)
}

export {pubmedHarvest}

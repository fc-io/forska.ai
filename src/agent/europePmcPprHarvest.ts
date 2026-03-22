import {type} from 'arktype'

import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {europePmcPprWorkflowStoreEntries} from './europePmcPprWorkflowStoreEntries.ts'

const EuropePmcAuthor = type({
  'fullName?': 'string',
  'firstName?': 'string',
  'lastName?': 'string',
  'initials?': 'string',
  'collectiveName?': 'string',
})
const EuropePmcAuthorList = type({'author?': EuropePmcAuthor.or(EuropePmcAuthor.array())})
const EuropePmcPubTypeList = type({'pubType?': 'string | string[]'})
const EuropePmcBookOrReportDetails = type({'publisher?': 'string', 'yearOfPublication?': 'string | number'})
const EuropePmcVersion = type({'pubTypeList?': EuropePmcPubTypeList})
const EuropePmcVersionList = type({'version?': EuropePmcVersion.or(EuropePmcVersion.array())})

const EuropePmcFullTextUrl = type({
  'availability?': 'string',
  'availabilityCode?': 'string',
  'documentStyle?': 'string',
  'site?': 'string',
  'url?': 'string',
})
const EuropePmcFullTextUrlList = type({'fullTextUrl?': EuropePmcFullTextUrl.or(EuropePmcFullTextUrl.array())})

const EuropePmcItem = type({
  id: 'string | number',
  source: 'string',
  'doi?': 'string',
  'title?': 'unknown',
  'authorString?': 'string',
  'authorList?': EuropePmcAuthorList,
  'abstractText?': 'string',
  'pubTypeList?': EuropePmcPubTypeList,
  'bookOrReportDetails?': EuropePmcBookOrReportDetails,
  'versionList?': EuropePmcVersionList,
  'firstPublicationDate?': 'string',
  'dateOfCreation?': 'string',
  'pubYear?': 'string | number',
  'pubMonth?': 'string | number',
  'pubDay?': 'string | number',
  'fullTextUrlList?': EuropePmcFullTextUrlList,
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

type HarvestOptions = {cursor?: string | null; onCursorUpdate?: (cursor: string | null) => Promise<void>}

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

const extractUrl = (it: typeof EuropePmcItem.infer): string | undefined => {
  const doi = typeof it.doi === 'string' ? it.doi.trim() : ''
  if (doi) return `https://doi.org/${doi}`
  const list = it.fullTextUrlList?.fullTextUrl
  const url = readArray(list)
    .map((x) => {
      return x.url
    })
    .find((u) => {
      return typeof u === 'string' && u.trim()
    })
  return typeof url === 'string' && url.trim() ? url : undefined
}

const buildQuery = (from: string, to: string): string => {
  const a = from.replaceAll('/', '-')
  const b = to.replaceAll('/', '-')
  return `SRC:PPR AND FIRST_PDATE:[${a} TO ${b}]`
}

const europePmcFetchTimeoutMs = 20_000
const europePmcRetryDelays = [10_000, 60_000, 600_000, 1_200_000, 1_800_000, 3_600_000]

const fetchWithTimeoutAndRetry = (url: URL, timeoutMs: number, retryDelays: number[]): Promise<Response> => {
  const attempt = (i: number): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    console.log(`Fetching Europe PMC URL: ${url.toString()}`)
    const p = fetch(url, {signal: controller.signal}).finally(() => {
      clearTimeout(timer)
    })
    return p.then(
      (res) => {
        console.log(`Europe PMC response: ${res.status} ${res.statusText}`)
        if (res.ok) return res

        const delay = retryDelays[i]
        if (delay === undefined) {
          return Promise.reject(new Error(`Europe PMC HTTP ${res.status}`))
        }

        console.log(
          `Request failed with status ${res.status}. Retrying in ${delay / 1000}s (attempt ${i + 1}/${retryDelays.length})`,
        )
        return sleep(delay).then(() => {
          return attempt(i + 1)
        })
      },
      (err) => {
        const delay = retryDelays[i]
        if (delay === undefined) {
          return Promise.reject(err)
        }

        console.log(
          `Request failed: ${String(err)}. Retrying in ${delay / 1000}s (attempt ${i + 1}/${retryDelays.length})`,
        )
        return sleep(delay).then(() => {
          return attempt(i + 1)
        })
      },
    )
  }
  return attempt(0)
}

const fetchEuropePmc = async (
  query: string,
  pageSize: number,
  cursorMark?: string,
): Promise<{items: (typeof EuropePmcItem.infer)[]; nextCursor?: string; hitCount: number}> => {
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search')
  url.searchParams.set('query', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('resultType', 'core')
  url.searchParams.set('pageSize', String(pageSize))
  if (cursorMark) url.searchParams.set('cursorMark', cursorMark)
  const res = await fetchWithTimeoutAndRetry(url, europePmcFetchTimeoutMs, europePmcRetryDelays)
  const json: unknown = await res.json()
  const parsed = EuropePmcResponse(json)
  if (parsed instanceof type.errors) {
    console.error('Invalid response from Europe PMC. Raw JSON:', JSON.stringify(json, null, 2))
    throw new Error(parsed.join('\n'))
  }
  const items = readArray(parsed.resultList?.result)
  const hitCount = (() => {
    if (typeof parsed.hitCount === 'number') return parsed.hitCount
    if (typeof parsed.hitCount === 'string') {
      const n = Number.parseInt(parsed.hitCount, 10)
      return Number.isNaN(n) ? items.length : n
    }
    return items.length
  })()
  const nextCursor = parsed.nextCursorMark
  return {items, nextCursor, hitCount}
}

const buildArticleId = (rawId: string): string => {
  const trimmed = rawId.trim()
  return trimmed ? `ppr:${trimmed}` : 'ppr:unknown'
}

const toDatabaseEntry = (it: typeof EuropePmcItem.infer, importRoute: string) => {
  const rawId = typeof it.id === 'number' ? String(it.id) : String(it.id)
  const createdAt = it.firstPublicationDate
    ? toIsoFromDateString(it.firstPublicationDate)
    : toIsoDate(it.pubYear, it.pubMonth, it.pubDay)
  const updatedAt = it.dateOfCreation ? toIsoFromDateString(it.dateOfCreation) : createdAt
  const doi = typeof it.doi === 'string' && it.doi.trim() ? it.doi.trim() : undefined
  const url = extractUrl(it)

  return {
    article_id: buildArticleId(rawId),
    article_title: extractTitle(it.title),
    article_summary: it.abstractText ?? '',
    article_authors: extractAuthors(it),
    article_created_at: createdAt,
    article_updated_at: updatedAt,
    article_version: '1',
    ...(doi ? {doi} : {}),
    ...(url ? {url} : {}),
    import_route: importRoute,
    original_data: it,
  }
}

const harvestPage = async (
  query: string,
  importRoute: string,
  pageSize: number,
  maxResults: number,
  cursorMark?: string,
  importedCount = 0,
  fetchedCount = 0,
  onCursorUpdate?: (cursor: string | null) => Promise<void>,
): Promise<number> => {
  const isInitialRun = cursorMark === '*'
  const baseImportedCount = isInitialRun ? 0 : importedCount
  const baseFetchedCount = isInitialRun ? 0 : fetchedCount

  const {items, nextCursor, hitCount} = await fetchEuropePmc(query, pageSize, cursorMark)
  if (onCursorUpdate) {
    await onCursorUpdate(nextCursor ?? null)
  }
  const remaining = Math.max(0, maxResults - baseImportedCount)
  const slice = items.slice(0, remaining)
  const hasId = (it: typeof EuropePmcItem.infer) => {
    const id = typeof it.id === 'number' || typeof it.id === 'string' ? String(it.id) : ''
    return Boolean(id && id.trim())
  }
  const entries = slice.filter(hasId).map((it) => {
    return toDatabaseEntry(it, importRoute)
  })

  if (entries.length > 0) {
    await europePmcPprWorkflowStoreEntries(entries)
  }

  const newImportedCount = baseImportedCount + entries.length
  const newFetchedCount = baseFetchedCount + items.length
  const doneByLimit = newImportedCount >= maxResults
  const noMoreByCursor = !nextCursor || nextCursor === cursorMark
  const doneByExhaustion = newImportedCount >= hitCount
  return doneByLimit || noMoreByCursor || doneByExhaustion
    ? newFetchedCount
    : (await sleep(100),
      harvestPage(
        query,
        importRoute,
        pageSize,
        maxResults,
        nextCursor,
        newImportedCount,
        newFetchedCount,
        onCursorUpdate,
      ))
}

const getStartCursor = (cursor?: string | null) => {
  const normalized = cursor?.trim() ?? ''
  return normalized ? normalized : '*'
}

export const europePmcPprHarvest = async (input: InputData & HarvestOptions): Promise<void> => {
  console.log('Europe PMC PPR harvest start', input)
  const query = buildQuery(input.fromDate, input.toDate)
  const pageSize = 1000
  const startCursor = getStartCursor(input.cursor)
  const fetchedTotal = await harvestPage(
    query,
    input.importRoute,
    pageSize,
    Number.POSITIVE_INFINITY,
    startCursor,
    0,
    0,
    input.onCursorUpdate,
  )
  console.log(`Europe PMC PPR harvest complete. Fetched ${fetchedTotal} preprints.`)
}

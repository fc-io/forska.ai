import {type} from 'arktype'

import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {pubmedHarvestGetIdParams} from './pubmedHarvest/pubmedHarvestGetIdParams.ts'
import {pubmedWorkflowStoreEntries} from './pubmedWorkflowStoreEntries.ts'

const EuropePmcAuthor = type({
  'fullName?': 'string',
  'firstName?': 'string',
  'lastName?': 'string',
  'initials?': 'string',
  'collectiveName?': 'string',
})
const EuropePmcAuthorList = type({'author?': EuropePmcAuthor.or(EuropePmcAuthor.array())})
const EuropePmcItem = type({
  'id?': 'string | number',
  source: 'string',
  'pmid?': 'string | number',
  'title?': 'unknown',
  'authorString?': 'string',
  'authorList?': EuropePmcAuthorList,
  'abstractText?': 'string',
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
  resultList: EuropePmcResultList,
  'nextCursorMark?': 'string',
  'nextPageUrl?': 'string',
  'request?': EuropePmcRequest,
})

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
  const it = items[i]
  if (it) {
    const hasId = typeof it.id === 'string' || typeof it.id === 'number'
    if (!hasId) {
      console.log('Europe PMC item missing id. Full item:', it)
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

const buildQuery = (from: string, to: string): string => {
  const a = from.replaceAll('/', '-')
  const b = to.replaceAll('/', '-')
  return `SRC:MED AND FIRST_PDATE:[${a} TO ${b}]`
}

const europePmcFetchTimeoutMs = 20_000
const europePmcRetryDelays = [
  10_000, // 10 seconds
  60_000, // 1 minute
  600_000, // 10 minutes
  1_200_000, // 20 minutes
  1_800_000, // 30 minutes
  3_600_000, // 1 hour
]

const fetchWithTimeoutAndRetry = (
  url: URL,
  timeoutMs: number,
  retryDelays: number[],
): Promise<Response> => {
  const attempt = (i: number): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    const p = fetch(url, {signal: controller.signal}).finally(() => {
      clearTimeout(timer)
    })
    return p.then(
      (res) => {
        if (res.ok) return res

        const delay = retryDelays[i]
        if (delay === undefined) {
          return Promise.reject(new Error(`Europe PMC HTTP ${res.status}`))
        }

        console.log(
          `Request failed with status ${res.status}. Retrying in ${delay / 1000}s (attempt ${i + 1}/${retryDelays.length})`,
        )
        return sleep(delay).then(() => attempt(i + 1))
      },
      (err) => {
        const delay = retryDelays[i]
        if (delay === undefined) {
          return Promise.reject(err)
        }

        console.log(
          `Request failed: ${String(err)}. Retrying in ${delay / 1000}s (attempt ${i + 1}/${retryDelays.length})`,
        )
        return sleep(delay).then(() => attempt(i + 1))
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
  // console.log('fetching', url.toString())
  const res = await fetchWithTimeoutAndRetry(url, europePmcFetchTimeoutMs, europePmcRetryDelays)
  const json: unknown = await res.json()
  const parsed = EuropePmcResponse(json)
  if (parsed instanceof type.errors) {
    console.error('Invalid response from Europe PMC')
    throw new Error(parsed.join('\n'))
  }
  console.log('hitCount', parsed.hitCount)
  const items = readArray(parsed.resultList.result)
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
  return {items, nextCursor, hitCount}
}

const toDatabaseEntry = (it: typeof EuropePmcItem.infer, importRoute: string) => {
  const pmidRaw = (typeof it.pmid === 'number' || typeof it.pmid === 'string') && it.pmid ? it.pmid : it.id
  const pmid = typeof pmidRaw === 'number' ? String(pmidRaw) : String(pmidRaw)
  const createdAt = it.firstPublicationDate
    ? toIsoFromDateString(it.firstPublicationDate)
    : toIsoDate(it.pubYear, it.pubMonth, it.pubDay)
  return {
    article_id: `pmid:${pmid}`,
    article_title: extractTitle(it.title),
    article_summary: it.abstractText ?? '',
    article_authors: extractAuthors(it),
    article_created_at: createdAt,
    article_updated_at: createdAt,
    article_version: '1',
    pubmed_id: pmid,
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
): Promise<number> => {
  const isInitialRun = cursorMark === '*'
  const baseImportedCount = isInitialRun ? 0 : importedCount
  const baseFetchedCount = isInitialRun ? 0 : fetchedCount

  const {items, nextCursor, hitCount} = await fetchEuropePmc(query, pageSize, cursorMark)
  const remaining = Math.max(0, maxResults - baseImportedCount)
  const slice = items.slice(0, remaining)
  const hasAnyId = (it: typeof EuropePmcItem.infer) => {
    const hasPmid = (typeof it.pmid === 'number' || typeof it.pmid === 'string') && String(it.pmid).length > 0
    const hasId = (typeof it.id === 'number' || typeof it.id === 'string') && String(it.id).length > 0
    return hasPmid || hasId
  }
  const entries = slice.filter(hasAnyId).map((it) => {
    return toDatabaseEntry(it, importRoute)
  })
  if (entries.length > 0) {
    await pubmedWorkflowStoreEntries(entries)
  }
  const newImportedCount = baseImportedCount + entries.length
  const newFetchedCount = baseFetchedCount + items.length
  const doneByLimit = newImportedCount >= maxResults
  const noMoreByCursor = !nextCursor || nextCursor === cursorMark
  const doneByExhaustion = newImportedCount >= hitCount
  return doneByLimit || noMoreByCursor || doneByExhaustion
    ? newFetchedCount
    : (await sleep(100),
      harvestPage(query, importRoute, pageSize, maxResults, nextCursor, newImportedCount, newFetchedCount))
}

const pubmedHarvest = async (input: InputData): Promise<void> => {
  const idParams = pubmedHarvestGetIdParams(input)
  const sp = idParams.searchParams
  const query = buildQuery(sp.mindate, sp.maxdate)
  const pageSize = 1000
  const fetchedTotal = await harvestPage(query, input.importRoute, pageSize, Number.POSITIVE_INFINITY, '*')
  console.log(`Europe PMC harvest complete. Fetched ${fetchedTotal} articles.`)
}

export {pubmedHarvest}

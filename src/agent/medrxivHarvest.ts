import {type} from 'arktype'

import {normalizeMedrxivIdentifier} from '../utils/articleIdentifierNormalization.ts'
import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {medrxivWorkflowStoreEntries} from './medrxivWorkflowStoreEntries.ts'

const MedrxivResponse = type({'collection?': 'unknown[]', 'messages?': 'unknown'})
type HarvestOptions = {cursor?: string | null; onCursorUpdate?: (cursor: string | null) => Promise<void>}
const medrxivTimeoutMs = 20_000
const medrxivRetryDelays = [
  10_000, // 10 seconds
  60_000, // 1 minute
  600_000, // 10 minutes
  1_200_000, // 20 minutes
  1_800_000, // 30 minutes
  3_600_000, // 1 hour
]
const medrxivRequestDelayMs = 1
const medrxivMaxPerPage = 100

const toStringOr = (value: unknown, fallback = ''): string => {
  return typeof value === 'string' ? value : fallback
}

const normalizeDoi = (value: unknown): string => {
  const outcome = normalizeMedrxivIdentifier(value)

  return outcome.status === 'accepted' ? outcome.identifier.normalizedValue : ''
}

const toIsoDate = (value: unknown): string => {
  const raw = toStringOr(value, '')
  return raw ? `${raw}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z'
}

const splitAuthors = (value: unknown): string[] => {
  const raw = toStringOr(value, '')
  if (!raw) return []
  return raw
    .split(/;|,| and /i)
    .map((a) => {
      return a.trim()
    })
    .filter(Boolean)
}

const buildArticleId = (server: string, doi: string, record: Record<string, unknown>): string => {
  if (doi) return `${server}:${doi}`
  const alt = toStringOr(record.rel_doi ?? record.preprint_doi ?? record.doi ?? '', '')
  if (alt) return `${server}:${alt}`
  const title = toStringOr(record.title, '')
  return title ? `${server}:${title.toLowerCase().replace(/\s+/g, '-')}` : `${server}:unknown`
}

const mapRecordToEntry = (record: Record<string, unknown>, importRoute: string) => {
  const doi = normalizeDoi(record.doi)
  const server = toStringOr(record.server, 'medrxiv')
  const date = toIsoDate(record.date ?? record.published)
  const version = toStringOr(record.version ?? record.rel_version, '1')
  const medrxivId = doi || toStringOr(record.rel_doi ?? record.preprint_doi ?? record.doi ?? '', '')
  const articleId = buildArticleId(server, doi, record)
  const urlFromRecord = toStringOr(record.link ?? record.jatsxml ?? record.rel_link, '')
  const url = doi ? `https://doi.org/${doi}` : urlFromRecord

  return {
    article_id: articleId,
    article_title: toStringOr(record.title, 'Untitled'),
    article_summary: toStringOr(record.abstract, ''),
    article_authors: splitAuthors(record.authors),
    article_updated_at: null,
    article_created_at: date,
    article_version: version,
    ...(medrxivId ? {medrxiv_id: medrxivId} : {}),
    doi,
    import_route: importRoute,
    url,
    original_data: record,
  }
}

const buildMedrxivUrl = (fromDate: string, toDate: string, cursor: number): URL => {
  return new URL(`https://api.biorxiv.org/details/medrxiv/${fromDate}/${toDate}/${cursor}`)
}

const fetchWithTimeoutAndRetry = (url: URL, timeoutMs: number, retryDelays: number[]): Promise<Response> => {
  const attempt = (i: number): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    console.log(`Fetching medRxiv URL: ${url}`)
    const request = fetch(url, {signal: controller.signal}).finally(() => {
      clearTimeout(timer)
    })
    return request.then(
      (res) => {
        console.log(`medRxiv response: ${res.status} ${res.statusText}`)
        if (res.ok) return res
        const delay = retryDelays[i]
        if (delay === undefined) {
          console.error(`medRxiv final failure: HTTP ${res.status} — ${url}`)
          return Promise.reject(new Error(`medRxiv HTTP ${res.status}`))
        }
        console.log(
          `medRxiv retry ${i + 1}/${retryDelays.length} after HTTP ${res.status} — waiting ${delay}ms — ${url}`,
        )
        return sleep(delay).then(() => {
          return attempt(i + 1)
        })
      },
      (err) => {
        const delay = retryDelays[i]
        if (delay === undefined) {
          console.error(`medRxiv final failure: ${String(err)} — ${url}`)
          return Promise.reject(err)
        }
        console.log(
          `medRxiv retry ${i + 1}/${retryDelays.length} after error ${String(err)} — waiting ${delay}ms — ${url}`,
        )
        return sleep(delay).then(() => {
          return attempt(i + 1)
        })
      },
    )
  }
  return attempt(0)
}

const fetchMedrxivPage = async (
  fromDate: string,
  toDate: string,
  cursor: number,
  shouldThrottle: boolean,
): Promise<unknown[]> => {
  if (shouldThrottle) {
    await sleep(medrxivRequestDelayMs)
  }
  const url = buildMedrxivUrl(fromDate, toDate, cursor)
  const response = await fetchWithTimeoutAndRetry(url, medrxivTimeoutMs, medrxivRetryDelays)
  const payload: unknown = await response.json()
  const parsed = MedrxivResponse.assert(payload)
  const collection = parsed.collection
  if (!Array.isArray(collection)) {
    return []
  }
  return collection.slice(0, medrxivMaxPerPage)
}

const harvestPage = async (
  input: InputData & HarvestOptions,
  cursor: number,
  shouldThrottle: boolean,
): Promise<void> => {
  const saveCursor = async (value: number) => {
    const cursorString = String(value)
    await input.onCursorUpdate?.(cursorString)
  }

  const records = await fetchMedrxivPage(input.fromDate, input.toDate, cursor, shouldThrottle)
  const nextCursor = records.length ? cursor + records.length : cursor
  await saveCursor(nextCursor)
  if (!records.length) {
    return
  }
  const entries = records
    .map((record) => {
      if (!record || typeof record !== 'object') {
        return null
      }
      return mapRecordToEntry(record as Record<string, unknown>, input.importRoute)
    })
    .filter((entry): entry is ReturnType<typeof mapRecordToEntry> => {
      return Boolean(entry)
    })

  if (entries.length > 0) {
    await medrxivWorkflowStoreEntries(entries)
  }

  await harvestPage(input, nextCursor, true)
}

const getStartCursor = (cursor?: string | null) => {
  const parsed = Number.parseInt(cursor ?? '', 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

export const medrxivHarvest = async (input: InputData & HarvestOptions): Promise<void> => {
  console.log('medRxiv harvest start', input)
  const startCursor = getStartCursor(input.cursor)
  await harvestPage(input, startCursor, false)
  console.log('medRxiv harvest complete')
}

import {type} from 'arktype'

import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {biorxivWorkflowStoreEntries} from './biorxivWorkflowStoreEntries.ts'

const BiorxivResponse = type({'collection?': 'unknown[]', 'messages?': 'unknown'})
const biorxivTimeoutMs = 20_000
const biorxivRetryDelays = [
  10_000, // 10 seconds
  60_000, // 1 minute
  600_000, // 10 minutes
  1_200_000, // 20 minutes
  1_800_000, // 30 minutes
  3_600_000, // 1 hour
]
const biorxivRequestDelayMs = 1
const biorxivMaxPerPage = 100

const toStringOr = (value: unknown, fallback = ''): string => {
  return typeof value === 'string' ? value : fallback
}

const normalizeDoi = (value: unknown): string => {
  const raw = toStringOr(value, '').trim()
  const lower = raw.toLowerCase()
  const prefixes = ['https://doi.org/', 'http://doi.org/', 'doi:']
  const prefix = prefixes.find((p) => {
    return lower.startsWith(p)
  })
  return prefix ? raw.slice(prefix.length) : raw
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
  const server = toStringOr(record.server, 'biorxiv')
  const date = toIsoDate(record.date ?? record.published)
  const version = toStringOr(record.version ?? record.rel_version, '1')
  const biorxivId = doi || toStringOr(record.rel_doi ?? record.preprint_doi ?? record.doi ?? '', '')
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
    ...(biorxivId ? {biorxiv_id: biorxivId} : {}),
    doi,
    import_route: importRoute,
    url,
    original_data: record,
  }
}

const buildBiorxivUrl = (fromDate: string, toDate: string, cursor: number): URL => {
  return new URL(`https://api.biorxiv.org/details/biorxiv/${fromDate}/${toDate}/${cursor}`)
}

const fetchWithTimeoutAndRetry = (url: URL, timeoutMs: number, retryDelays: number[]): Promise<Response> => {
  const attempt = (i: number): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    console.log(`Fetching BioRxiv URL: ${url}`)
    const request = fetch(url, {signal: controller.signal}).finally(() => {
      clearTimeout(timer)
    })
    return request.then(
      (res) => {
        console.log(`BioRxiv response: ${res.status} ${res.statusText}`)
        if (res.ok) return res
        const delay = retryDelays[i]
        if (delay === undefined) {
          console.error(`BioRxiv final failure: HTTP ${res.status} — ${url}`)
          return Promise.reject(new Error(`BioRxiv HTTP ${res.status}`))
        }
        console.log(
          `BioRxiv retry ${i + 1}/${retryDelays.length} after HTTP ${res.status} — waiting ${delay}ms — ${url}`,
        )
        return sleep(delay).then(() => {
          return attempt(i + 1)
        })
      },
      (err) => {
        const delay = retryDelays[i]
        if (delay === undefined) {
          console.error(`BioRxiv final failure: ${String(err)} — ${url}`)
          return Promise.reject(err)
        }
        console.log(
          `BioRxiv retry ${i + 1}/${retryDelays.length} after error ${String(err)} — waiting ${delay}ms — ${url}`,
        )
        return sleep(delay).then(() => {
          return attempt(i + 1)
        })
      },
    )
  }
  return attempt(0)
}

const fetchBiorxivPage = async (
  fromDate: string,
  toDate: string,
  cursor: number,
  shouldThrottle: boolean,
): Promise<unknown[]> => {
  if (shouldThrottle) {
    await sleep(biorxivRequestDelayMs)
  }
  const url = buildBiorxivUrl(fromDate, toDate, cursor)
  const response = await fetchWithTimeoutAndRetry(url, biorxivTimeoutMs, biorxivRetryDelays)
  const payload: unknown = await response.json()
  const parsed = BiorxivResponse.assert(payload)
  const collection = parsed.collection
  if (!Array.isArray(collection)) {
    return []
  }
  return collection.slice(0, biorxivMaxPerPage)
}

const harvestPage = async (input: InputData, cursor: number, shouldThrottle: boolean): Promise<void> => {
  const records = await fetchBiorxivPage(input.fromDate, input.toDate, cursor, shouldThrottle)
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
    await biorxivWorkflowStoreEntries(entries)
  }

  await harvestPage(input, cursor + 1, true)
}

export const biorxivHarvest = async (input: InputData): Promise<void> => {
  console.log('BioRxiv harvest start', input)
  await harvestPage(input, 0, false)
  console.log('BioRxiv harvest complete')
}

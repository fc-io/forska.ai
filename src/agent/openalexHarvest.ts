import {type} from 'arktype'

import {env} from '../server/utils/env.ts'
import {sleep} from '../utils/sleep.ts'
import type {InputData} from './arxivWorkflow/arxivWorkflowHarvest.ts'
import {openalexWorkflowStoreEntries} from './openalexWorkflowStoreEntries.ts'

const OpenAlexMeta = type({
  'count?': 'number',
  'db_response_time_ms?': 'number',
  'next_cursor?': 'string | null | undefined',
})

const OpenAlexResponse = type({'meta?': OpenAlexMeta, 'results?': 'unknown[]'})

const toStringOr = (v: unknown, d = ''): string => {
  return typeof v === 'string' ? v : d
}

const toNumberOr = (v: unknown, d = 0): number => {
  return typeof v === 'number' ? v : d
}

const normalizeDoi = (s: unknown): string => {
  const raw = toStringOr(s, '').trim()
  const lower = raw.toLowerCase()
  const prefixes = ['https://doi.org/', 'http://doi.org/', 'doi:']
  const p = prefixes.find((x) => {
    return lower.startsWith(x)
  })
  return p ? raw.slice(p.length) : raw
}

const reconstructAbstract = (idx: unknown): string => {
  const isObj = typeof idx === 'object' && idx !== null
  if (!isObj) return ''
  const entries = Object.entries(idx as Record<string, unknown>)
  const positions = entries
    .flatMap(([token, arr]) => {
      const pos = Array.isArray(arr) ? arr : []
      return pos.map((n) => {
        return {n: typeof n === 'number' ? n : -1, token}
      })
    })
    .filter((p) => {
      return p.n >= 0
    })
    .sort((a, b) => {
      return a.n - b.n
    })
  const max = positions.length > 0 ? (positions[positions.length - 1]?.n ?? 0) : 0
  const arr: string[] = Array.from({length: max + 1}).map(() => {
    return ''
  })
  positions.forEach((p) => {
    arr[p.n] = p.token
  })
  return arr
    .filter((s) => {
      return s.length > 0
    })
    .join(' ')
}

const getShortId = (id: unknown): string => {
  const raw = toStringOr(id, '')
  return raw.replace('https://openalex.org/', '')
}

const toIsoDate = (s: unknown, fallbackYear?: unknown): string => {
  const date = toStringOr(s, '')
  if (date) return `${date}T00:00:00.000Z`
  const y = toNumberOr(fallbackYear, 1970)
  const yy = Number.isFinite(y) && y > 0 ? y : 1970
  return `${String(yy)}-01-01T00:00:00.000Z`
}

const pickVenue = (work: Record<string, unknown>): string => {
  const pl = work.primary_location as Record<string, unknown> | undefined
  const src = pl && typeof pl === 'object' ? (pl.source as Record<string, unknown> | undefined) : undefined
  const name = src && typeof src === 'object' ? toStringOr(src.display_name, '') : ''
  return name
}

const pickUrl = (work: Record<string, unknown>): string => {
  const pl = work.primary_location as Record<string, unknown> | undefined
  const landing = pl && typeof pl === 'object' ? toStringOr(pl.landing_page_url, '') : ''
  const doi = normalizeDoi(work.doi)
  const doiUrl = doi ? `https://doi.org/${doi}` : ''
  return landing || doiUrl
}

const mapWorkToEntry = (work: unknown, importRoute: string) => {
  const obj = typeof work === 'object' && work ? (work as Record<string, unknown>) : {}
  const shortId = getShortId(obj.id)
  const articleId = `openalex:${shortId}`
  const title = toStringOr(obj.title, toStringOr(obj.display_name, ''))
  const abstract = reconstructAbstract(obj.abstract_inverted_index)
  const authorships = Array.isArray(obj.authorships) ? (obj.authorships as unknown[]) : []
  const authors = authorships
    .map((a) => {
      const aa = typeof a === 'object' && a ? (a as Record<string, unknown>) : undefined
      const author =
        aa && typeof aa.author === 'object' && aa.author !== null ? (aa.author as Record<string, unknown>) : undefined
      return author ? toStringOr(author.display_name, '') : ''
    })
    .filter((s) => {
      return s.length > 0
    })
  const created = toIsoDate(obj.publication_date, obj.publication_year)
  const updatedDate = toStringOr(obj.updated_date, '')
  const updated = updatedDate ? `${updatedDate}T00:00:00.000Z` : created
  const doi = normalizeDoi(obj.doi)
  const language = toStringOr(obj.language, '')
  const venue = pickVenue(obj)
  const url = pickUrl(obj)
  return {
    article_id: articleId,
    article_title: title,
    article_summary: abstract,
    article_authors: authors,
    article_updated_at: updated,
    article_created_at: created,
    article_version: '1',
    doi,
    openalex_id: shortId,
    language,
    venue,
    import_route: importRoute,
    url,
    original_data: obj,
  }
}

const fetchWithTimeout = (url: URL, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  return fetch(url, {signal: controller.signal}).finally(() => {
    clearTimeout(timer)
  })
}

const retryDelaysDefault = [10_000, 60_000, 600_000, 1_200_000, 1_800_000, 3_600_000]

const fetchOpenAlexPage = (url: URL, timeoutMs: number, retryDelays: number[]): Promise<Response> => {
  const attempt = (i: number): Promise<Response> => {
    return fetchWithTimeout(url, timeoutMs).then(
      async (res) => {
        if (res.ok) return res
        if (res.status === 429) {
          const ra = res.headers.get('retry-after')
          const fromHeader = ra ? Number.parseInt(ra, 10) : NaN
          const delayMs = Number.isFinite(fromHeader) ? fromHeader * 1000 : (retryDelays[i] ?? 0)
          const d = delayMs > 0 ? delayMs : 10_000
          console.log(`OpenAlex 429. Backing off for ${Math.round(d / 1000)}s`)
          await sleep(d)
          return attempt(i + 1)
        }
        if (res.status >= 400 && res.status < 500) {
          // client error – return to caller to allow fallback adjustments
          return res
        }
        const delay = retryDelays[i]
        if (delay === undefined) {
          return Promise.reject(new Error(`OpenAlex HTTP ${res.status}`))
        }
        console.log(`OpenAlex ${res.status}. Retrying in ${delay / 1000}s (attempt ${i + 1})`)
        await sleep(delay)
        return attempt(i + 1)
      },
      async (err) => {
        const delay = retryDelays[i]
        if (delay === undefined) {
          return Promise.reject(err)
        }
        console.log(`OpenAlex request failed: ${String(err)}. Retrying in ${delay / 1000}s (attempt ${i + 1})`)
        await sleep(delay)
        return attempt(i + 1)
      },
    )
  }
  return attempt(0)
}

type PerParam = 'per-page' | 'per_page'

const buildOpenAlexUrl = (
  fromDate: string,
  toDate: string,
  mailto: string,
  cursor: string,
  perPage: number,
  perParam: PerParam,
  includeSelect: boolean,
): URL => {
  const url = new URL('https://api.openalex.org/works')
  url.searchParams.set('mailto', mailto)
  url.searchParams.set(perParam, String(perPage))
  url.searchParams.set('cursor', cursor)
  // Use a single filter param with comma-separated filters
  const filter = [
    `from_publication_date:${fromDate}`,
    `to_publication_date:${toDate}`,
    'type:journal-article',
    'is_paratext:false',
  ].join(',')
  url.searchParams.set('filter', filter)
  if (includeSelect) {
    const select = [
      'id',
      'title',
      'abstract_inverted_index',
      'authorships',
      'publication_date',
      'doi',
      'primary_location',
      'open_access',
      'cited_by_count',
      'language',
      'concepts',
    ].join(',')
    url.searchParams.set('select', select)
  }
  return url
}

export const openalexHarvest = async (input: InputData): Promise<void> => {
  const mailto = env.OPENALEX_MAILTO
  if (!mailto || String(mailto).trim() === '') {
    throw new Error('OPENALEX_MAILTO is required in environment')
  }

  const timeoutMs = 20_000
  const maxRps = 10
  const minDelay = Math.ceil(1000 / maxRps)
  const perPage = 200

  const variants: Array<{perParam: PerParam; includeSelect: boolean}> = [
    {perParam: 'per-page', includeSelect: true},
    {perParam: 'per-page', includeSelect: false},
    {perParam: 'per_page', includeSelect: false},
  ]

  const fetchFirstWithFallback = async (
    i: number,
  ): Promise<{parsed: typeof OpenAlexResponse.infer; variant: {perParam: PerParam; includeSelect: boolean}}> => {
    const v = variants[i]
    if (!v) {
      throw new Error('OpenAlex request failed with 400 for all variants')
    }
    const url = buildOpenAlexUrl(input.fromDate, input.toDate, mailto, '*', perPage, v.perParam, v.includeSelect)
    console.log('OpenAlex fetching', url.toString())
    const res = await fetchOpenAlexPage(url, timeoutMs, retryDelaysDefault)
    if (res.status === 400) {
      const text = await res.text()
      console.log(`OpenAlex 400 for variant ${i + 1}. Response:`, text)
      return fetchFirstWithFallback(i + 1)
    }
    const json: unknown = await res.json()
    const parsed = OpenAlexResponse(json)
    if (parsed instanceof type.errors) {
      console.error('Invalid OpenAlex response')
      throw new Error(parsed.join('\n'))
    }
    return {parsed, variant: v}
  }

  const firstResult = await fetchFirstWithFallback(0)
  const parsed = firstResult.parsed
  const chosen = firstResult.variant
  const countInfo = parsed.meta?.count ?? 'unknown'
  const first = Array.isArray(parsed.results) && parsed.results.length > 0 ? parsed.results[0] : undefined
  console.log('OpenAlex meta:', parsed.meta)
  console.log('OpenAlex first result example:', first)
  const initialResults = Array.isArray(parsed.results) ? parsed.results : []
  const initialEntries = initialResults.map((w) => {
    return mapWorkToEntry(w, input.importRoute)
  })
  if (initialEntries.length > 0) {
    await openalexWorkflowStoreEntries(initialEntries)
  }

  const harvestNext = async (cursor: string | null | undefined, prev?: string): Promise<void> => {
    const cur = typeof cursor === 'string' ? cursor : null
    const repeated = cur && prev && cur === prev
    const done = !cur || repeated
    if (done) return
    await sleep(minDelay)
    const url = buildOpenAlexUrl(
      input.fromDate,
      input.toDate,
      mailto,
      cur,
      perPage,
      chosen.perParam,
      chosen.includeSelect,
    )
    const res = await fetchOpenAlexPage(url, timeoutMs, retryDelaysDefault)
    if (res.status === 400) {
      const text = await res.text()
      console.log('OpenAlex 400 mid-harvest. Response:', text)
      return
    }
    const json: unknown = await res.json()
    const page = OpenAlexResponse(json)
    if (page instanceof type.errors) {
      console.error('Invalid OpenAlex response')
      throw new Error(page.join('\n'))
    }
    const works = Array.isArray(page.results) ? page.results : []
    const entries = works.map((w) => {
      return mapWorkToEntry(w, input.importRoute)
    })
    if (entries.length > 0) {
      await openalexWorkflowStoreEntries(entries)
    }
    return harvestNext(page.meta?.next_cursor ?? null, cur)
  }

  await harvestNext(parsed.meta?.next_cursor ?? null, '*')
  console.log(`OpenAlex harvest complete. Reported count=${countInfo}. Stored initial=${initialEntries.length}`)
}

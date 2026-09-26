import {sleep} from '../utils/sleep.ts'
import {
  type EuropePmcCursorPosition,
  getEuropePmcCursorPosition,
  getSavedEuropePmcCursor,
} from './europePmcCursorWalk/europePmcWalkCursor.ts'
import {fetchEuropePmcWithRetry} from './europePmcCursorWalk/fetchEuropePmcWithRetry.ts'
import {type EuropePmcWalkEndReason, logEuropePmcShortWalk} from './europePmcCursorWalk/logEuropePmcShortWalk.ts'

export type EuropePmcPageRequest = {cursorMark: string; query: string; signal: AbortSignal; sort: string | null}

export type EuropePmcFetchedPage<Item> = {hitCount: number; items: Item[]; nextCursor?: string; rawPage: unknown}

export type EuropePmcCursorWalkPage<Item> = {
  cursorAfter: string | null
  cursorBefore: string
  fetchedCount: number
  hitCount: number
  importableItems: Item[]
  importedCount: number
  items: Item[]
  pageIndex: number
  rawPage: unknown
}

type EuropePmcCursorWalkInput<Item> = {
  cursor?: string | null
  dataSourceId?: string
  fetchPage: (request: EuropePmcPageRequest) => Promise<EuropePmcFetchedPage<Item>>
  fromDate: string
  importRoute: string
  isImportable: (item: Item) => boolean
  onPage: (page: EuropePmcCursorWalkPage<Item>) => Promise<void> | void
  query: string
  toDate: string
}

type SettledEuropePmcPage<Item> = {error: unknown; ok: false} | {fetched: EuropePmcFetchedPage<Item>; ok: true}

type EuropePmcWalkStep =
  | {endReason: EuropePmcWalkEndReason; nextCursorMark: null}
  | {endReason: null; nextCursorMark: string}

const europePmcPageSize = 1000
const europePmcRequestGapMs = 100

export const fetchEuropePmcSearchJson = async (request: EuropePmcPageRequest): Promise<unknown> => {
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search')
  url.searchParams.set('query', request.query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('resultType', 'core')
  url.searchParams.set('pageSize', String(europePmcPageSize))
  url.searchParams.set('cursorMark', request.cursorMark)
  if (request.sort) url.searchParams.set('sort', request.sort)
  const res = await fetchEuropePmcWithRetry(url, request.signal)

  return (await res.json()) as unknown
}

const settleEuropePmcPage = <Item>(page: Promise<EuropePmcFetchedPage<Item>>): Promise<SettledEuropePmcPage<Item>> => {
  return page.then(
    (fetched): SettledEuropePmcPage<Item> => {
      return {fetched, ok: true}
    },
    (error: unknown): SettledEuropePmcPage<Item> => {
      return {error, ok: false}
    },
  )
}

const getFetchedEuropePmcPage = async <Item>(
  settledPage: Promise<SettledEuropePmcPage<Item>>,
): Promise<EuropePmcFetchedPage<Item>> => {
  const settled = await settledPage

  if (!settled.ok) {
    throw settled.error
  }

  return settled.fetched
}

const getWalkStep = (input: {
  cursorMark: string
  hitCount: number
  importedCount: number
  nextCursor: string | undefined
}): EuropePmcWalkStep => {
  if (input.importedCount >= input.hitCount) return {endReason: 'hit-count-reached', nextCursorMark: null}
  if (!input.nextCursor) return {endReason: 'no-next-cursor', nextCursorMark: null}
  return input.nextCursor === input.cursorMark
    ? {endReason: 'same-cursor', nextCursorMark: null}
    : {endReason: null, nextCursorMark: input.nextCursor}
}

const getFetchedOffset = (start: EuropePmcCursorPosition, fetchedCount: number) => {
  return start.fetchedOffset === null ? null : start.fetchedOffset + fetchedCount
}

const getSavedCursorAt = (start: EuropePmcCursorPosition, cursorMark: string, fetchedCount: number) => {
  return getSavedEuropePmcCursor({cursorMark, fetchedOffset: getFetchedOffset(start, fetchedCount), sort: start.sort})
}

export const walkEuropePmcCursorPages = async <Item>(
  input: EuropePmcCursorWalkInput<Item>,
): Promise<{fetchedTotal: number; pageCount: number}> => {
  const start = getEuropePmcCursorPosition(input.cursor)
  const abortController = new AbortController()
  const fetchPage = (cursorMark: string) => {
    return input.fetchPage({cursorMark, query: input.query, signal: abortController.signal, sort: start.sort})
  }
  let pendingPage = settleEuropePmcPage(fetchPage(start.cursorMark))
  let cursorMark = start.cursorMark
  let fetchedCount = 0
  let importedCount = 0
  let pageIndex = 0

  try {
    while (true) {
      const {hitCount, items, nextCursor, rawPage} = await getFetchedEuropePmcPage(pendingPage)
      const importableItems = items.filter(input.isImportable)
      const newFetchedCount = fetchedCount + items.length
      const newImportedCount = importedCount + importableItems.length
      const step = getWalkStep({cursorMark, hitCount, importedCount: newImportedCount, nextCursor})
      const nextCursorMark = step.nextCursorMark

      if (nextCursorMark !== null) {
        pendingPage = settleEuropePmcPage(
          sleep(europePmcRequestGapMs).then(async () => {
            return await fetchPage(nextCursorMark)
          }),
        )
      }

      await input.onPage({
        cursorAfter: nextCursorMark === null ? null : getSavedCursorAt(start, nextCursorMark, newFetchedCount),
        cursorBefore: getSavedCursorAt(start, cursorMark, fetchedCount),
        fetchedCount: newFetchedCount,
        hitCount,
        importableItems,
        importedCount: newImportedCount,
        items,
        pageIndex,
        rawPage,
      })

      if (step.endReason !== null) {
        logEuropePmcShortWalk({
          dataSourceId: input.dataSourceId ?? null,
          endReason: step.endReason,
          fetchedTotal: getFetchedOffset(start, newFetchedCount),
          fromDate: input.fromDate,
          hitCount,
          importRoute: input.importRoute,
          pageCount: pageIndex + 1,
          query: input.query,
          sort: start.sort,
          toDate: input.toDate,
        })
        return {fetchedTotal: newFetchedCount, pageCount: pageIndex + 1}
      }

      cursorMark = step.nextCursorMark
      fetchedCount = newFetchedCount
      importedCount = newImportedCount
      pageIndex += 1
    }
  } finally {
    abortController.abort()
  }
}

import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, mock, test} from 'bun:test'

import {installRuntimeJsonlSink, resetRuntimeJsonlSinkForTests} from '../server/utils/runtimeLogger.ts'
import type {EuropePmcFetchedPage, EuropePmcPageRequest} from './europePmcCursorWalk.ts'

type TestItem = {id: string}
type TestPage = EuropePmcFetchedPage<TestItem>

const sleepModulePath = new URL('../utils/sleep.ts', import.meta.url).href
const logDirsRef: {current: string[]} = {current: []}
const unhandledRejectionsRef: {current: unknown[]} = {current: []}
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejectionsRef.current.push(reason)
}

const loadWalkModule = async () => {
  void mock.module(sleepModulePath, () => {
    return {
      sleep: async () => {
        return undefined
      },
    }
  })

  return (await import(
    `./europePmcCursorWalk.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./europePmcCursorWalk.ts')
}

const waitMs = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

const getTestPage = (input: {hitCount: number; ids: string[]; nextCursor?: string}): TestPage => {
  return {
    hitCount: input.hitCount,
    items: input.ids.map((id) => {
      return {id}
    }),
    ...(input.nextCursor ? {nextCursor: input.nextCursor} : {}),
    rawPage: {ids: input.ids},
  }
}

const createPageFetcher = (pagesByCursorMark: Record<string, TestPage>) => {
  const requests: Array<Pick<EuropePmcPageRequest, 'cursorMark' | 'sort'>> = []

  return {
    fetchPage: async (request: EuropePmcPageRequest) => {
      requests.push({cursorMark: request.cursorMark, sort: request.sort})
      const page = pagesByCursorMark[request.cursorMark]

      if (!page) {
        throw new Error(`Unexpected Europe PMC cursor ${request.cursorMark}`)
      }

      return page
    },
    requests,
  }
}

const getWalkInput = () => {
  return {
    dataSourceId: 'data-source-1',
    fromDate: '2026-05-01',
    importRoute: '/api/datasources/import/pubmed',
    isImportable: (item: TestItem) => {
      return item.id.length > 0
    },
    query: 'SRC:MED AND FIRST_PDATE:[2026-05-01 TO 2026-09-01]',
    toDate: '2026-09-01',
  }
}

const getCaughtError = async (promise: Promise<unknown>) => {
  return await promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
}

const installTestLogSink = () => {
  const logDir = mkdtempSync(join(tmpdir(), 'forska-europe-pmc-walk-'))
  logDirsRef.current.push(logDir)
  installRuntimeJsonlSink({envValues: {LOG_DIR: logDir, LOG_LEVEL: 'INFO', SERVER_ROLE: 'maintenance'}})

  return logDir
}

const readShortWalkEvents = (logDir: string) => {
  return readdirSync(logDir)
    .filter((name) => {
      return name.endsWith('.jsonl')
    })
    .flatMap((name) => {
      return readFileSync(join(logDir, name), 'utf8').split('\n').filter(Boolean)
    })
    .map((line) => {
      return JSON.parse(line) as {attrs: Record<string, unknown>; event: string; message: string; severity: string}
    })
    .filter((record) => {
      return record.event === 'data-source-import.europe-pmc-short-walk'
    })
}

afterEach(() => {
  process.off('unhandledRejection', onUnhandledRejection)
  unhandledRejectionsRef.current = []
  resetRuntimeJsonlSinkForTests()
  logDirsRef.current.map((logDir) => {
    rmSync(logDir, {force: true, recursive: true})
    return logDir
  })
  logDirsRef.current = []
  mock.restore()
})

test('a fresh walk sorts by first publication date and saves versioned cursors with the fetched offset', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const fetcher = createPageFetcher({
    '*': getTestPage({hitCount: 5, ids: ['1', '2'], nextCursor: 'mark-1'}),
    'mark-1': getTestPage({hitCount: 5, ids: ['3', '4'], nextCursor: 'mark-2'}),
    'mark-2': getTestPage({hitCount: 5, ids: ['5']}),
  })
  const pages: Array<{cursorAfter: string | null; cursorBefore: string; pageIndex: number}> = []

  const result = await walkEuropePmcCursorPages({
    ...getWalkInput(),
    cursor: null,
    fetchPage: fetcher.fetchPage,
    onPage: (page) => {
      pages.push({cursorAfter: page.cursorAfter, cursorBefore: page.cursorBefore, pageIndex: page.pageIndex})
    },
  })

  expect(result).toEqual({fetchedTotal: 5, pageCount: 3})
  expect(fetcher.requests).toEqual([
    {cursorMark: '*', sort: 'FIRST_PDATE_D asc'},
    {cursorMark: 'mark-1', sort: 'FIRST_PDATE_D asc'},
    {cursorMark: 'mark-2', sort: 'FIRST_PDATE_D asc'},
  ])
  expect(pages).toEqual([
    {cursorBefore: '*', cursorAfter: 'v2:2:mark-1', pageIndex: 0},
    {cursorBefore: 'v2:2:mark-1', cursorAfter: 'v2:4:mark-2', pageIndex: 1},
    {cursorBefore: 'v2:4:mark-2', cursorAfter: null, pageIndex: 2},
  ])
})

test('a versioned cursor resumes the date-sorted walk from its cursor mark and offset', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const fetcher = createPageFetcher({
    'mark-7': getTestPage({hitCount: 4003, ids: ['7001', '7002'], nextCursor: 'mark-8'}),
    'mark-8': getTestPage({hitCount: 4003, ids: ['8001']}),
  })
  const cursors: Array<string | null> = []

  await walkEuropePmcCursorPages({
    ...getWalkInput(),
    cursor: 'v2:4000:mark-7',
    fetchPage: fetcher.fetchPage,
    onPage: (page) => {
      cursors.push(page.cursorBefore, page.cursorAfter)
    },
  })

  expect(fetcher.requests).toEqual([
    {cursorMark: 'mark-7', sort: 'FIRST_PDATE_D asc'},
    {cursorMark: 'mark-8', sort: 'FIRST_PDATE_D asc'},
  ])
  expect(cursors).toEqual(['v2:4000:mark-7', 'v2:4002:mark-8', 'v2:4002:mark-8', null])
})

test('a legacy relevance cursor resumes without a sort and keeps saving unversioned cursors', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const fetcher = createPageFetcher({
    'AoIIP/0lVCg1NTY1NTgzMQ==': getTestPage({hitCount: 10, ids: ['1'], nextCursor: 'AoIIP/LvcyAx'}),
    'AoIIP/LvcyAx': getTestPage({hitCount: 10, ids: ['2']}),
  })
  const cursors: Array<string | null> = []

  await walkEuropePmcCursorPages({
    ...getWalkInput(),
    cursor: 'AoIIP/0lVCg1NTY1NTgzMQ==',
    fetchPage: fetcher.fetchPage,
    onPage: (page) => {
      cursors.push(page.cursorBefore, page.cursorAfter)
    },
  })

  expect(fetcher.requests).toEqual([
    {cursorMark: 'AoIIP/0lVCg1NTY1NTgzMQ==', sort: null},
    {cursorMark: 'AoIIP/LvcyAx', sort: null},
  ])
  expect(cursors).toEqual(['AoIIP/0lVCg1NTY1NTgzMQ==', 'AoIIP/LvcyAx', 'AoIIP/LvcyAx', null])
})

test('the next page is fetched while the current page is stored, with one Europe PMC request in flight', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const pagesByCursorMark: Record<string, TestPage> = {
    '*': getTestPage({hitCount: 3, ids: ['1'], nextCursor: 'mark-1'}),
    'mark-1': getTestPage({hitCount: 3, ids: ['2'], nextCursor: 'mark-2'}),
    'mark-2': getTestPage({hitCount: 3, ids: ['3']}),
  }
  const events: string[] = []
  const inFlight = {current: 0, max: 0}

  await walkEuropePmcCursorPages({
    ...getWalkInput(),
    cursor: null,
    fetchPage: async (request) => {
      events.push(`fetch-start:${request.cursorMark}`)
      inFlight.current += 1
      inFlight.max = Math.max(inFlight.max, inFlight.current)
      await waitMs(1)
      inFlight.current -= 1
      events.push(`fetch-end:${request.cursorMark}`)

      return pagesByCursorMark[request.cursorMark] ?? getTestPage({hitCount: 3, ids: []})
    },
    onPage: async (page) => {
      events.push(`store-start:${page.pageIndex}`)
      await waitMs(20)
      events.push(`store-end:${page.pageIndex}`, `cursor:${page.cursorAfter}`)
    },
  })

  expect(inFlight.max).toBe(1)
  expect(events).toEqual([
    'fetch-start:*',
    'fetch-end:*',
    'store-start:0',
    'fetch-start:mark-1',
    'fetch-end:mark-1',
    'store-end:0',
    'cursor:v2:1:mark-1',
    'store-start:1',
    'fetch-start:mark-2',
    'fetch-end:mark-2',
    'store-end:1',
    'cursor:v2:2:mark-2',
    'store-start:2',
    'store-end:2',
    'cursor:null',
  ])
})

test('a failing store aborts the pending prefetch without an unhandled rejection or a cursor save', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const prefetchSignals: AbortSignal[] = []
  const events: string[] = []
  process.on('unhandledRejection', onUnhandledRejection)

  const error = await getCaughtError(
    walkEuropePmcCursorPages({
      ...getWalkInput(),
      cursor: null,
      fetchPage: async (request) => {
        events.push(`fetch:${request.cursorMark}`)

        if (request.cursorMark === '*') {
          return getTestPage({hitCount: 3000, ids: ['1'], nextCursor: 'mark-1'})
        }

        prefetchSignals.push(request.signal)
        return await new Promise<TestPage>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new Error('Europe PMC prefetch aborted'))
          })
        })
      },
      onPage: async () => {
        await waitMs(5)
        throw new Error('store failed')
      },
    }),
  )
  await waitMs(20)

  expect(String(error)).toContain('store failed')
  expect(events).toEqual(['fetch:*', 'fetch:mark-1'])
  expect(
    prefetchSignals.map((signal) => {
      return signal.aborted
    }),
  ).toEqual([true])
  expect(unhandledRejectionsRef.current).toEqual([])
})

test('a failed prefetch surfaces only after the current page and its cursor are saved', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const events: string[] = []
  process.on('unhandledRejection', onUnhandledRejection)

  const error = await getCaughtError(
    walkEuropePmcCursorPages({
      ...getWalkInput(),
      cursor: null,
      fetchPage: async (request) => {
        events.push(`fetch:${request.cursorMark}`)

        return request.cursorMark === '*'
          ? getTestPage({hitCount: 3000, ids: ['1'], nextCursor: 'mark-1'})
          : await Promise.reject(new Error('Europe PMC HTTP 503'))
      },
      onPage: async (page) => {
        await waitMs(20)
        events.push(`store:${page.pageIndex}`, `cursor:${page.cursorAfter}`)
      },
    }),
  )
  await waitMs(20)

  expect(String(error)).toContain('Europe PMC HTTP 503')
  expect(events).toEqual(['fetch:*', 'fetch:mark-1', 'store:0', 'cursor:v2:1:mark-1'])
  expect(unhandledRejectionsRef.current).toEqual([])
})

test('a walk that ends clearly below the hit count logs a short-walk warning', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const logDir = installTestLogSink()
  const fetcher = createPageFetcher({
    '*': getTestPage({hitCount: 5000, ids: ['1', '2'], nextCursor: 'mark-1'}),
    'mark-1': getTestPage({hitCount: 5000, ids: ['3'], nextCursor: 'mark-1'}),
  })

  await walkEuropePmcCursorPages({...getWalkInput(), cursor: null, fetchPage: fetcher.fetchPage, onPage: () => {}})

  const [shortWalkEvent, ...otherEvents] = readShortWalkEvents(logDir)

  expect(otherEvents).toEqual([])
  expect(shortWalkEvent).toMatchObject({
    attrs: {
      dataSourceId: 'data-source-1',
      endReason: 'same-cursor',
      fetchedCount: 3,
      fromDate: '2026-05-01',
      hitCount: 5000,
      importRoute: '/api/datasources/import/pubmed',
      missingCount: 4997,
      pageCount: 2,
      query: 'SRC:MED AND FIRST_PDATE:[2026-05-01 TO 2026-09-01]',
      sort: 'FIRST_PDATE_D asc',
      toDate: '2026-09-01',
    },
    event: 'data-source-import.europe-pmc-short-walk',
    severity: 'WARN',
  })
  expect(shortWalkEvent?.message).toContain('after 3 of 5000 hits')
})

test('the short-walk check counts records fetched before a versioned resume and skips legacy resumes', async () => {
  const {walkEuropePmcCursorPages} = await loadWalkModule()
  const logDir = installTestLogSink()
  const walks = [
    {cursor: 'v2:4998:mark-9', mark: 'mark-9'},
    {cursor: 'v2:10:mark-9', mark: 'mark-9'},
    {cursor: 'AoIIP7+Q5Sg1NTYxMjk0OQ==', mark: 'AoIIP7+Q5Sg1NTYxMjk0OQ=='},
  ]

  await walks.reduce(async (previous, walk) => {
    await previous
    const fetcher = createPageFetcher({[walk.mark]: getTestPage({hitCount: 5000, ids: ['1', '2']})})

    await walkEuropePmcCursorPages({
      ...getWalkInput(),
      cursor: walk.cursor,
      fetchPage: fetcher.fetchPage,
      onPage: () => {},
    })
  }, Promise.resolve())

  expect(
    readShortWalkEvents(logDir).map((record) => {
      return {endReason: record.attrs.endReason, fetchedCount: record.attrs.fetchedCount}
    }),
  ).toEqual([{endReason: 'no-next-cursor', fetchedCount: 12}])
})

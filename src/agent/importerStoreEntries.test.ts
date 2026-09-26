import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {afterEach, expect, mock, test} from 'bun:test'

const articleImportStoreServiceModulePath = new URL('../server/services/articleImportStoreService.ts', import.meta.url)
  .href
const appDatabaseServiceModulePath = new URL('../server/services/appDatabaseService.ts', import.meta.url).href
const sleepModulePath = new URL('../utils/sleep.ts', import.meta.url).href

type StoredArticleRow = Record<string, unknown>

const storedRowsRef: {current: StoredArticleRow[][]} = {current: []}
const storeFailureRef: {current: Error | null} = {current: null}
const storeFailureQueueRef: {current: Error[]} = {current: []}
const importEventsRef: {current: string[]} = {current: []}
const originalFetch = globalThis.fetch

const registerModuleMocks = () => {
  void mock.module(articleImportStoreServiceModulePath, () => {
    return {
      articleImportStoreWorkloadContext: {
        allowsTempSpill: true,
        fallbackIntent: 'reject',
        routeOrJobKey: 'import.storeArticles',
        timeoutMs: 120_000,
        workloadClass: 'background.importStore',
      },
      storeImportedArticles: async (rows: StoredArticleRow[]) => {
        const queuedFailure = storeFailureQueueRef.current.shift()
        if (queuedFailure) {
          importEventsRef.current.push(`store-failed:${rows.length}`)
          throw queuedFailure
        }
        if (storeFailureRef.current) {
          throw storeFailureRef.current
        }
        importEventsRef.current.push(`store:${rows.length}`)
        storedRowsRef.current.push(rows)
      },
    }
  })

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async (statement: string) => {
            if (statement.includes('FROM app.import_route')) {
              return [{id: 'import-route-1'}]
            }

            return []
          },
          run: async () => {
            return undefined
          },
        }
      },
    }
  })

  void mock.module(sleepModulePath, () => {
    return {
      sleep: async () => {
        return undefined
      },
    }
  })
}

const loadAgentModule = async <T>(relativePath: string): Promise<T> => {
  registerModuleMocks()

  return (await import(`${relativePath}?test=${Date.now()}-${Math.random()}`)) as T
}

const getStoredRows = () => {
  return storedRowsRef.current.flatMap((batch) => {
    return batch
  })
}

const getFetchUrl = (input: RequestInfo | URL): string => {
  return typeof input === 'string' || input instanceof URL ? input.toString() : input.url
}

const mockEuropePmcFetchPages = (pages: unknown[]) => {
  const requestedUrls: string[] = []
  let pageIndex = 0

  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    requestedUrls.push(getFetchUrl(input))
    const page = pages[pageIndex]
    pageIndex += 1
    if (!page) {
      throw new Error(`Unexpected Europe PMC fetch ${pageIndex}`)
    }

    return new Response(JSON.stringify(page), {status: 200, statusText: 'OK'})
  }) as unknown as typeof fetch

  return {requestedUrls}
}

afterEach(() => {
  storedRowsRef.current = []
  storeFailureRef.current = null
  storeFailureQueueRef.current = []
  importEventsRef.current = []
  globalThis.fetch = originalFetch
  mock.restore()
})

test('pubmed harvest mapping keeps DOI and import metadata', async () => {
  const {pubmedHarvestToDatabaseEntry} =
    await loadAgentModule<typeof import('./pubmedHarvest.ts')>('./pubmedHarvest.ts')

  expect(
    pubmedHarvestToDatabaseEntry(
      {
        id: '12345',
        source: 'MED',
        pmid: '12345',
        doi: 'https://doi.org/10.1000/pubmed-doi',
        title: 'PubMed title',
        abstractText: 'PubMed abstract',
        authorList: {author: [{fullName: 'Alice Example'}]},
        journalTitle: 'Nature',
        firstPublicationDate: '2024-01-02',
      },
      '/api/datasources/import/pubmed',
    ),
  ).toEqual({
    article_id: 'pmid:12345',
    article_title: 'PubMed title',
    article_summary: 'PubMed abstract',
    article_authors: ['Alice Example'],
    article_created_at: '2024-01-02T00:00:00.000Z',
    article_updated_at: '2024-01-02T00:00:00.000Z',
    article_version: '1',
    doi: '10.1000/pubmed-doi',
    pubmed_id: '12345',
    import_route: '/api/datasources/import/pubmed',
    original_data: {
      id: '12345',
      source: 'MED',
      pmid: '12345',
      doi: 'https://doi.org/10.1000/pubmed-doi',
      title: 'PubMed title',
      abstractText: 'PubMed abstract',
      authorList: {author: [{fullName: 'Alice Example'}]},
      journalTitle: 'Nature',
      firstPublicationDate: '2024-01-02',
    },
  })
})

test('pubmed page fetch callback receives ordered cursors and normalized records', async () => {
  mockEuropePmcFetchPages([
    {
      hitCount: 2,
      nextCursorMark: 'cursor-1',
      resultList: {
        result: [
          {
            id: '1001',
            source: 'MED',
            pmid: '1001',
            title: 'PubMed page one',
            abstractText: 'First abstract',
            firstPublicationDate: '2024-01-01',
          },
        ],
      },
    },
    {
      hitCount: 2,
      nextCursorMark: 'cursor-terminal',
      resultList: {
        result: [
          {
            id: '1002',
            source: 'MED',
            pmid: '1002',
            title: 'PubMed page two',
            abstractText: 'Second abstract',
            firstPublicationDate: '2024-01-02',
          },
        ],
      },
    },
  ])
  const {fetchPubmedHarvestPages} = await loadAgentModule<typeof import('./pubmedHarvest.ts')>('./pubmedHarvest.ts')
  const callbacks: Array<{
    cursorAfter: string | null
    cursorBefore: string
    ids: string[]
    pageIndex: number
    sourceRecordCount: number
  }> = []

  const result = await fetchPubmedHarvestPages({
    fromDate: '2024-01-01',
    toDate: '2024-01-02',
    importRoute: '/api/datasources/import/pubmed',
    cursor: 'resume-cursor',
    onPage: (page) => {
      callbacks.push({
        cursorBefore: page.cursorBefore,
        cursorAfter: page.cursorAfter,
        pageIndex: page.pageIndex,
        ids: page.normalizedRecords.map((row) => {
          return row.articleId
        }),
        sourceRecordCount: page.sourceRecordCount,
      })
    },
  })

  expect(result).toEqual({fetchedTotal: 2, pageCount: 2})
  expect(callbacks).toEqual([
    {cursorBefore: 'resume-cursor', cursorAfter: 'cursor-1', pageIndex: 0, ids: ['pmid:1001'], sourceRecordCount: 1},
    {cursorBefore: 'cursor-1', cursorAfter: null, pageIndex: 1, ids: ['pmid:1002'], sourceRecordCount: 1},
  ])
  expect(getStoredRows()).toEqual([])
})

test('pubmed harvest preserves legacy cursor update and workflow store path', async () => {
  mockEuropePmcFetchPages([
    {
      hitCount: 1,
      resultList: {
        result: [
          {
            id: '2001',
            source: 'MED',
            pmid: '2001',
            title: 'Stored PubMed page',
            abstractText: 'Stored abstract',
            authorList: {author: [{fullName: 'PubMed Author'}]},
            firstPublicationDate: '2024-01-03',
          },
        ],
      },
    },
  ])
  const {pubmedHarvest} = await loadAgentModule<typeof import('./pubmedHarvest.ts')>('./pubmedHarvest.ts')
  const cursorUpdates: (string | null)[] = []

  await pubmedHarvest({
    fromDate: '2024-01-03',
    toDate: '2024-01-03',
    importRoute: '/api/datasources/import/pubmed',
    cursor: null,
    onCursorUpdate: async (cursor) => {
      cursorUpdates.push(cursor)
    },
  })

  expect(cursorUpdates).toEqual([null])
  expect(getStoredRows()).toHaveLength(1)
  expect(getStoredRows()[0]).toMatchObject({
    articleId: 'pmid:2001',
    articleTitle: 'Stored PubMed page',
    articleSummary: 'Stored abstract',
    articleAuthors: ['PubMed Author'],
    articleVersion: 1,
    pubmedId: '2001',
    importRoute: '/api/datasources/import/pubmed',
  })
})

const getTwoPageEuropePmcResponses = (source: 'MED' | 'PPR') => {
  return [1, 2].map((pageNumber) => {
    return {
      hitCount: 2,
      ...(pageNumber === 1 ? {nextCursorMark: 'cursor-1'} : {}),
      resultList: {
        result: [
          {
            id: `${source}300${pageNumber}`,
            source,
            ...(source === 'MED' ? {pmid: `300${pageNumber}`} : {doi: `10.1101/2024.03.0${pageNumber}.123456`}),
            title: `Page ${pageNumber}`,
            firstPublicationDate: '2024-03-01',
          },
        ],
      },
    }
  })
}

const getCursorOrderHarvests = async () => {
  const {pubmedHarvest} = await loadAgentModule<typeof import('./pubmedHarvest.ts')>('./pubmedHarvest.ts')
  const {europePmcPprHarvest} =
    await loadAgentModule<typeof import('./europePmcPprHarvest.ts')>('./europePmcPprHarvest.ts')

  return [
    {harvest: pubmedHarvest, importRoute: '/api/datasources/import/pubmed', source: 'MED' as const},
    {harvest: europePmcPprHarvest, importRoute: '/api/datasources/import/europe-pmc-ppr', source: 'PPR' as const},
  ]
}

const runCursorOrderHarvest = async (input: Awaited<ReturnType<typeof getCursorOrderHarvests>>[number]) => {
  mockEuropePmcFetchPages(getTwoPageEuropePmcResponses(input.source))

  return await input.harvest({
    fromDate: '2024-03-01',
    toDate: '2024-03-01',
    importRoute: input.importRoute,
    cursor: null,
    onCursorUpdate: async (cursor) => {
      importEventsRef.current.push(`cursor:${cursor}`)
    },
  })
}

test('europe pmc harvests save each page cursor only after the page is stored', async () => {
  const harvests = await getCursorOrderHarvests()

  await harvests.reduce(async (previous, harvest) => {
    await previous
    importEventsRef.current = []
    await runCursorOrderHarvest(harvest)

    expect(importEventsRef.current).toEqual(['store:1', 'cursor:cursor-1', 'store:1', 'cursor:null'])
  }, Promise.resolve())
})

test('europe pmc harvests keep the previous cursor when storing a page fails', async () => {
  const harvests = await getCursorOrderHarvests()

  storeFailureRef.current = new Error('store failed')
  await harvests.reduce(async (previous, harvest) => {
    await previous
    importEventsRef.current = []

    const error = await runCursorOrderHarvest(harvest).then(
      () => {
        return null
      },
      (caught: unknown) => {
        return caught
      },
    )

    expect(String(error)).toContain('store failed')
    expect(importEventsRef.current).toEqual([])
  }, Promise.resolve())
})

test('europe pmc harvests report page counts, the hit count and the page key with each cursor save', async () => {
  const harvests = await getCursorOrderHarvests()

  await harvests.reduce(async (previous, harvest) => {
    await previous
    mockEuropePmcFetchPages(getTwoPageEuropePmcResponses(harvest.source))
    const saves: unknown[] = []

    await harvest.harvest({
      fromDate: '2024-03-01',
      toDate: '2024-03-01',
      importRoute: harvest.importRoute,
      cursor: null,
      onCursorUpdate: async (cursor, progress) => {
        saves.push({cursor, progress})
      },
    })

    expect(saves).toEqual([
      {cursor: 'cursor-1', progress: {fetchedCount: 1, pageKey: '*', storedCount: 1, totalCount: 2}},
      {cursor: null, progress: {fetchedCount: 1, pageKey: 'cursor-1', storedCount: 1, totalCount: 2}},
    ])
  }, Promise.resolve())
})

test('europe pmc harvests retry the same page after a transient store failure', async () => {
  const harvests = await getCursorOrderHarvests()

  await harvests.reduce(async (previous, harvest) => {
    await previous
    importEventsRef.current = []
    storeFailureQueueRef.current = [
      new Error(
        'DuckDB workload budget exceeded for import.storeArticles: duration 487605ms exceeded timeout 120000ms',
      ),
    ]

    await runCursorOrderHarvest(harvest)

    expect(importEventsRef.current).toEqual(['store-failed:1', 'store:1', 'cursor:cursor-1', 'store:1', 'cursor:null'])
  }, Promise.resolve())
})

test('europe pmc harvests store the page again when saving its cursor fails transiently', async () => {
  const harvests = await getCursorOrderHarvests()

  await harvests.reduce(async (previous, harvest) => {
    await previous
    importEventsRef.current = []
    mockEuropePmcFetchPages(getTwoPageEuropePmcResponses(harvest.source))
    const cursorFailures = [new Error('DuckDB connection not started')]

    await harvest.harvest({
      fromDate: '2024-03-01',
      toDate: '2024-03-01',
      importRoute: harvest.importRoute,
      cursor: null,
      onCursorUpdate: async (cursor) => {
        const failure = cursorFailures.shift()
        if (failure) {
          importEventsRef.current.push(`cursor-failed:${cursor}`)
          throw failure
        }
        importEventsRef.current.push(`cursor:${cursor}`)
      },
    })

    expect(importEventsRef.current).toEqual([
      'store:1',
      'cursor-failed:cursor-1',
      'store:1',
      'cursor:cursor-1',
      'store:1',
      'cursor:null',
    ])
  }, Promise.resolve())
})

test('europe pmc harvests fail a page right away when its cursor save loses the import lease', async () => {
  const harvests = await getCursorOrderHarvests()

  await harvests.reduce(async (previous, harvest) => {
    await previous
    importEventsRef.current = []
    mockEuropePmcFetchPages(getTwoPageEuropePmcResponses(harvest.source))

    const error = await harvest
      .harvest({
        fromDate: '2024-03-01',
        toDate: '2024-03-01',
        importRoute: harvest.importRoute,
        cursor: null,
        onCursorUpdate: async (cursor) => {
          importEventsRef.current.push(`cursor-failed:${cursor}`)
          throw new Error('Data source import lease was lost')
        },
      })
      .then(
        () => {
          return null
        },
        (caught: unknown) => {
          return caught
        },
      )

    expect(String(error)).toContain('Data source import lease was lost')
    expect(importEventsRef.current).toEqual(['store:1', 'cursor-failed:cursor-1'])
  }, Promise.resolve())
})

test('medrxiv and biorxiv harvests retry the same page after a transient store failure', async () => {
  const {medrxivHarvest} = await loadAgentModule<typeof import('./medrxivHarvest.ts')>('./medrxivHarvest.ts')
  const {biorxivHarvest} = await loadAgentModule<typeof import('./biorxivHarvest.ts')>('./biorxivHarvest.ts')
  const harvests = [
    {harvest: medrxivHarvest, importRoute: '/api/datasources/import/medrxiv', server: 'medrxiv'},
    {harvest: biorxivHarvest, importRoute: '/api/datasources/import/biorxiv', server: 'biorxiv'},
  ]

  await harvests.reduce(async (previous, harvest) => {
    await previous
    importEventsRef.current = []
    storeFailureQueueRef.current = [new Error('The operation timed out.')]
    const pages = [
      {
        collection: [
          {
            doi: '10.1101/2024.03.01.123456',
            server: harvest.server,
            title: 'Preprint page',
            date: '2024-03-01',
            version: '1',
          },
        ],
      },
      {collection: []},
    ]
    globalThis.fetch = mock(async () => {
      const page = pages.shift()
      if (!page) {
        throw new Error('Unexpected preprint fetch')
      }

      return new Response(JSON.stringify(page), {status: 200, statusText: 'OK'})
    }) as unknown as typeof fetch

    await harvest.harvest({
      fromDate: '2024-03-01',
      toDate: '2024-03-01',
      importRoute: harvest.importRoute,
      cursor: null,
      onCursorUpdate: async (cursor) => {
        importEventsRef.current.push(`cursor:${cursor}`)
      },
    })

    expect(importEventsRef.current).toEqual(['store-failed:1', 'store:1', 'cursor:1', 'cursor:1'])
  }, Promise.resolve())
})

test('pubmed workflow store entries pass DOI into storeImportedArticles', async () => {
  const {pubmedWorkflowStoreEntries} = await loadAgentModule<typeof import('./pubmedWorkflowStoreEntries.ts')>(
    './pubmedWorkflowStoreEntries.ts',
  )

  await pubmedWorkflowStoreEntries([
    {
      article_id: 'pmid:12345',
      article_title: 'PubMed title',
      article_summary: 'PubMed abstract',
      article_authors: ['Alice Example'],
      article_updated_at: '2024-01-02T00:00:00.000Z',
      article_created_at: '2024-01-02T00:00:00.000Z',
      article_version: '1',
      doi: '10.1000/pubmed-doi',
      pubmed_id: '12345',
      import_route: '/api/datasources/import/pubmed',
      original_data: {journalTitle: 'Nature'},
    },
  ])

  expect(getStoredRows()).toEqual([
    {
      articleId: 'pmid:12345',
      articleTitle: 'PubMed title',
      articleSummary: 'PubMed abstract',
      articleAuthors: ['Alice Example'],
      articleUpdatedAt: new Date('2024-01-02T00:00:00.000Z'),
      articleCreatedAt: new Date('2024-01-02T00:00:00.000Z'),
      articleVersion: 1,
      doi: '10.1000/pubmed-doi',
      pubmedId: '12345',
      originalData: {journalTitle: 'Nature'},
      importRoute: '/api/datasources/import/pubmed',
    },
  ])
})

test('arxiv workflow store entries pass arxiv payloads through the import service', async () => {
  const {arxivWorkflowStoreEntires} = await loadAgentModule<
    typeof import('./arxivWorkflow/arxivWorkflowStoreEntires.ts')
  >('./arxivWorkflow/arxivWorkflowStoreEntires.ts')

  await arxivWorkflowStoreEntires(
    [
      {
        id: 'http://arxiv.org/abs/2401.12345v2',
        title: 'ArXiv title',
        summary: 'ArXiv summary',
        updated: '2024-01-03T00:00:00.000Z',
        published: '2024-01-01T00:00:00.000Z',
        author: [{name: 'Alice Example'}],
        link: ['https://arxiv.org/abs/2401.12345v2'],
      },
    ],
    '/api/datasources/import/arxiv',
  )

  expect(getStoredRows()).toEqual([
    {
      articleId: 'http://arxiv.org/abs/2401.12345v2',
      articleTitle: 'ArXiv title',
      articleSummary: 'ArXiv summary',
      articleAuthors: ['Alice Example'],
      articleUpdatedAt: new Date('2024-01-03T00:00:00.000Z'),
      articleCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
      articleVersion: 2,
      arxivId: '2401.12345v2',
      importRoute: '/api/datasources/import/arxiv',
      originalData: {
        id: 'http://arxiv.org/abs/2401.12345v2',
        title: 'ArXiv title',
        summary: 'ArXiv summary',
        updated: '2024-01-03T00:00:00.000Z',
        published: '2024-01-01T00:00:00.000Z',
        author: [{name: 'Alice Example'}],
        link: ['https://arxiv.org/abs/2401.12345v2'],
      },
    },
  ])
})

test('biorxiv workflow store entries pass normalized DOI and URL', async () => {
  const {biorxivWorkflowStoreEntries} = await loadAgentModule<typeof import('./biorxivWorkflowStoreEntries.ts')>(
    './biorxivWorkflowStoreEntries.ts',
  )

  await biorxivWorkflowStoreEntries([
    {
      article_id: 'biorxiv:10.1101/2024.01.01.123456',
      article_title: 'bioRxiv title',
      article_summary: 'bioRxiv summary',
      article_authors: ['Alice Example'],
      article_updated_at: null,
      article_created_at: '2024-01-01T00:00:00.000Z',
      article_version: '2',
      biorxiv_id: '10.1101/2024.01.01.123456',
      doi: '10.1101/2024.01.01.123456',
      import_route: '/api/datasources/import/biorxiv',
      url: 'https://doi.org/10.1101/2024.01.01.123456',
      original_data: {server: 'biorxiv'},
    },
  ])

  expect(getStoredRows()[0]).toMatchObject({
    articleId: 'biorxiv:10.1101/2024.01.01.123456',
    biorxivId: '10.1101/2024.01.01.123456',
    doi: '10.1101/2024.01.01.123456',
    url: 'https://doi.org/10.1101/2024.01.01.123456',
    importRoute: '/api/datasources/import/biorxiv',
    originalData: {server: 'biorxiv'},
  })
})

test('medrxiv workflow store entries pass normalized DOI and URL', async () => {
  const {medrxivWorkflowStoreEntries} = await loadAgentModule<typeof import('./medrxivWorkflowStoreEntries.ts')>(
    './medrxivWorkflowStoreEntries.ts',
  )

  await medrxivWorkflowStoreEntries([
    {
      article_id: 'medrxiv:10.1101/2024.01.01.654321',
      article_title: 'medRxiv title',
      article_summary: 'medRxiv summary',
      article_authors: ['Alice Example'],
      article_updated_at: null,
      article_created_at: '2024-01-01T00:00:00.000Z',
      article_version: '3',
      medrxiv_id: '10.1101/2024.01.01.654321',
      doi: '10.1101/2024.01.01.654321',
      import_route: '/api/datasources/import/medrxiv',
      url: 'https://doi.org/10.1101/2024.01.01.654321',
      original_data: {server: 'medrxiv'},
    },
  ])

  expect(getStoredRows()[0]).toMatchObject({
    articleId: 'medrxiv:10.1101/2024.01.01.654321',
    medrxivId: '10.1101/2024.01.01.654321',
    doi: '10.1101/2024.01.01.654321',
    url: 'https://doi.org/10.1101/2024.01.01.654321',
    importRoute: '/api/datasources/import/medrxiv',
    originalData: {server: 'medrxiv'},
  })
})

test('europe pmc ppr workflow store entries pass DOI, URL, and raw payload', async () => {
  const {europePmcPprWorkflowStoreEntries} = await loadAgentModule<
    typeof import('./europePmcPprWorkflowStoreEntries.ts')
  >('./europePmcPprWorkflowStoreEntries.ts')

  await europePmcPprWorkflowStoreEntries([
    {
      article_id: 'ppr:12345',
      article_title: 'PPR title',
      article_summary: 'PPR summary',
      article_authors: ['Alice Example'],
      article_updated_at: '2024-01-03T00:00:00.000Z',
      article_created_at: '2024-01-01T00:00:00.000Z',
      article_version: '1',
      doi: '10.1101/2024.01.01.999999',
      url: 'https://doi.org/10.1101/2024.01.01.999999',
      import_route: '/api/datasources/import/europe-pmc-ppr',
      original_data: {
        source: 'PPR',
        fullTextUrlList: {fullTextUrl: [{url: 'https://example.org/ppr.pdf', site: 'Europe PMC'}]},
      },
    },
  ])

  expect(getStoredRows()[0]).toMatchObject({
    articleId: 'ppr:12345',
    doi: '10.1101/2024.01.01.999999',
    url: 'https://doi.org/10.1101/2024.01.01.999999',
    importRoute: '/api/datasources/import/europe-pmc-ppr',
    originalData: {
      source: 'PPR',
      fullTextUrlList: {fullTextUrl: [{url: 'https://example.org/ppr.pdf', site: 'Europe PMC'}]},
    },
  })
})

test('europe pmc ppr page fetch callback receives ordered cursors and normalized records', async () => {
  mockEuropePmcFetchPages([
    {
      hitCount: 2,
      nextCursorMark: 'ppr-cursor-1',
      resultList: {
        result: [
          {
            id: 'PPR1001',
            source: 'PPR',
            title: 'PPR page one',
            abstractText: 'First PPR abstract',
            firstPublicationDate: '2024-02-01',
          },
        ],
      },
    },
    {
      hitCount: 2,
      nextCursorMark: 'ppr-cursor-terminal',
      resultList: {
        result: [
          {
            id: 'PPR1002',
            source: 'PPR',
            title: 'PPR page two',
            abstractText: 'Second PPR abstract',
            firstPublicationDate: '2024-02-02',
          },
        ],
      },
    },
  ])
  const {fetchEuropePmcPprHarvestPages} =
    await loadAgentModule<typeof import('./europePmcPprHarvest.ts')>('./europePmcPprHarvest.ts')
  const callbacks: Array<{
    cursorAfter: string | null
    cursorBefore: string
    ids: string[]
    pageIndex: number
    sourceRecordCount: number
  }> = []

  const result = await fetchEuropePmcPprHarvestPages({
    fromDate: '2024-02-01',
    toDate: '2024-02-02',
    importRoute: '/api/datasources/import/europe-pmc-ppr',
    cursor: 'ppr-resume-cursor',
    onPage: (page) => {
      callbacks.push({
        cursorBefore: page.cursorBefore,
        cursorAfter: page.cursorAfter,
        pageIndex: page.pageIndex,
        ids: page.normalizedRecords.map((row) => {
          return row.articleId
        }),
        sourceRecordCount: page.sourceRecordCount,
      })
    },
  })

  expect(result).toEqual({fetchedTotal: 2, pageCount: 2})
  expect(callbacks).toEqual([
    {
      cursorBefore: 'ppr-resume-cursor',
      cursorAfter: 'ppr-cursor-1',
      pageIndex: 0,
      ids: ['ppr:PPR1001'],
      sourceRecordCount: 1,
    },
    {cursorBefore: 'ppr-cursor-1', cursorAfter: null, pageIndex: 1, ids: ['ppr:PPR1002'], sourceRecordCount: 1},
  ])
  expect(getStoredRows()).toEqual([])
})

test('europe pmc ppr harvest preserves legacy cursor update and workflow store path', async () => {
  mockEuropePmcFetchPages([
    {
      hitCount: 1,
      resultList: {
        result: [
          {
            id: 'PPR2001',
            source: 'PPR',
            doi: '10.1101/2024.02.03.123456',
            title: 'Stored PPR page',
            abstractText: 'Stored PPR abstract',
            authorList: {author: [{fullName: 'PPR Author'}]},
            firstPublicationDate: '2024-02-03',
          },
        ],
      },
    },
  ])
  const {europePmcPprHarvest} =
    await loadAgentModule<typeof import('./europePmcPprHarvest.ts')>('./europePmcPprHarvest.ts')
  const cursorUpdates: (string | null)[] = []

  await europePmcPprHarvest({
    fromDate: '2024-02-03',
    toDate: '2024-02-03',
    importRoute: '/api/datasources/import/europe-pmc-ppr',
    cursor: null,
    onCursorUpdate: async (cursor) => {
      cursorUpdates.push(cursor)
    },
  })

  expect(cursorUpdates).toEqual([null])
  expect(getStoredRows()).toHaveLength(1)
  expect(getStoredRows()[0]).toMatchObject({
    articleId: 'ppr:PPR2001',
    articleTitle: 'Stored PPR page',
    articleSummary: 'Stored PPR abstract',
    articleAuthors: ['PPR Author'],
    articleVersion: 1,
    doi: '10.1101/2024.02.03.123456',
    url: 'https://doi.org/10.1101/2024.02.03.123456',
    importRoute: '/api/datasources/import/europe-pmc-ppr',
  })
})

test('fhir importer stores synthesized article payloads through the import service', async () => {
  const tempAssetsPath = mkdtempSync(join(process.cwd(), 'assets/fhir-importer-test-'))
  const shardPath = join(tempAssetsPath, 'patient.ndjson')

  try {
    writeFileSync(
      shardPath,
      `${JSON.stringify({resourceType: 'Patient', id: 'patient-1', name: [{text: 'Alice Example'}]})}\n`,
    )

    const {fhirEhrPatientsWorkflowStoreEntries} = await loadAgentModule<
      typeof import('./fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts')
    >('./fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts')

    const result = await fhirEhrPatientsWorkflowStoreEntries({
      assetsFolder: relative(process.cwd(), tempAssetsPath).replaceAll('\\', '/'),
      importRoute: 'fhir:test-suite',
      dryRun: false,
    })

    expect(result).toMatchObject({patientsTotal: 1, inserted: 1, updated: 0, skipped: 0, errors: 0})
    const [storedRow] = getStoredRows()

    expect(getStoredRows()).toHaveLength(1)
    expect(storedRow).toMatchObject({
      articleId: 'fhir:test-suite:Patient/patient-1',
      articleTitle: 'FHIR Patient patient-1',
      importRoute: 'fhir:test-suite',
      articleAuthors: null,
      fullTextConversionStatus: 'success',
    })
    expect((storedRow?.originalData as {recordType?: string} | undefined)?.recordType).toBe('fhir_patient')
  } finally {
    rmSync(tempAssetsPath, {force: true, recursive: true})
  }
})

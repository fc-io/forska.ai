import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import type {DataSourceRecord} from '../../db/schemaTypes.ts'
import type {ArticleImportStoreRow, ArticleImportStoreTx} from './articleImportStoreService.ts'
import {
  createDataSourceTrackingProviderRegistry,
  pubmedTrackedImportRoute,
} from './dataSourceTrackingProviderRegistry.ts'
import {createDataSourceTrackingSpoolIngester} from './dataSourceTrackingSpoolIngester.ts'
import {createDataSourceTrackingSpoolRepository} from './dataSourceTrackingSpoolRepository.ts'

const getDataSource = (): DataSourceRecord => {
  return {
    archived: false,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    cursor: null,
    dateFrom: new Date('2026-01-01T00:00:00.000Z'),
    dateTo: null,
    description: null,
    id: 'source-1',
    importRoute: pubmedTrackedImportRoute,
    itemsAfterLastImport: 0,
    lastImportAt: null,
    title: 'Tracked source',
    trackingEnabled: true,
    trackingReconcileScheduleMonths: [3, 12, 24, 36],
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  }
}

const getDataSourceFenceRows = (dataSource: DataSourceRecord = getDataSource()) => {
  return [
    {
      archived: dataSource.archived,
      dateFrom: dataSource.dateFrom,
      dateTo: dataSource.dateTo,
      importRoute: dataSource.importRoute,
      trackingEnabled: dataSource.trackingEnabled,
      updatedAt: dataSource.updatedAt,
    },
  ]
}

const withSpoolRepository = async <T>(
  operation: (repository: ReturnType<typeof createDataSourceTrackingSpoolRepository>) => Promise<T>,
) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-data-source-spool-ingester-'))
  const repository = createDataSourceTrackingSpoolRepository({sqlitePath: join(root, 'tracking-spool.sqlite')})

  try {
    return await operation(repository)
  } finally {
    repository.close()
    rmSync(root, {force: true, recursive: true})
  }
}

const createReadyWindow = (
  spoolRepository: ReturnType<typeof createDataSourceTrackingSpoolRepository>,
  input: {
    runKind?: 'automatic_age_bucket' | 'incremental' | 'manual_full_range'
    windowEnd?: Date
    windowStart?: Date
  } = {},
) => {
  const window = spoolRepository.createOrResumeWindow({
    dataSourceId: 'source-1',
    route: pubmedTrackedImportRoute,
    runKind: input.runKind ?? 'incremental',
    windowEnd: input.windowEnd ?? new Date('2026-09-15T00:00:00.000Z'),
    windowStart: input.windowStart ?? new Date('2026-09-15T00:00:00.000Z'),
  })

  spoolRepository.appendPage({
    cursorAfter: null,
    cursorBefore: '*',
    normalizedRecordsJson: [
      {
        articleAuthors: ['Ada Lovelace'],
        articleCreatedAt: '2026-09-15T00:00:00.000Z',
        articleId: 'pmid:1',
        articleSummary: 'Abstract',
        articleTitle: 'Article 1',
        articleUpdatedAt: '2026-09-15T00:00:00.000Z',
        importRoute: pubmedTrackedImportRoute,
      },
    ],
    pageIndex: 0,
    rawPayloadJson: {page: 1},
    sourceRecordCount: 1,
    sourceRecordHash: 'hash-page-1',
    windowId: window.id,
  })
  spoolRepository.markWindowReady({spooledAt: new Date('2026-09-16T09:00:00.000Z'), windowId: window.id})

  return window
}

const getTrackingLeaseRepositoryStub = () => {
  return {
    claimImportLease: async () => {
      return {leaseOwner: 'source-lease'}
    },
    releaseSourceLease: async () => {
      return null
    },
    renewSourceLease: async () => {
      return {leaseOwner: 'source-lease'}
    },
  }
}

test('spool ingester uses a background DuckDB transaction before advancing high water and marking spool ingested', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository)
    const originalMarkWindowIngested = spoolRepository.markWindowIngested
    spoolRepository.markWindowIngested = (input) => {
      order.push('spool:mark-ingested')
      return originalMarkWindowIngested(input)
    }
    const database = {
      transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
        order.push('duckdb:transaction-background:start')
        const result = await operation({
          queryJson: async () => {
            return getDataSourceFenceRows()
          },
          run: async () => {
            return undefined
          },
        })
        order.push('duckdb:transaction-background:commit')
        return result
      },
    }
    const trackingRepository = {
      ...getTrackingLeaseRepositoryStub(),
      recordTrackingFailure: async () => {
        order.push('tracking:failure')
        return null
      },
      recordTrackingSuccess: async () => {
        order.push('tracking:success')
        return null
      },
    }
    const dataSourceQueryService = {
      countArticlesLinkedToImportRoute: async () => {
        order.push('datasource:count-linked')
        return 1
      },
      getDataSourceById: async () => {
        return getDataSource()
      },
      updateDataSourceAfterImport: async () => {
        order.push('datasource:update-after-import')
        return getDataSource()
      },
    }
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: dataSourceQueryService as never,
      database: database as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          fetchWindowPages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            return new Date('2026-09-17T00:00:00.000Z')
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      spoolRepository,
      storeImportedArticlesWithTx: async (_tx, rows: ArticleImportStoreRow[], options) => {
        order.push('duckdb:store-imported-articles')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.articleCreatedAt).toBeInstanceOf(Date)
        expect(rows[0]?.importRunId).toBe(`data-source-tracking:${readyWindow.id}`)
        expect(options?.changeLogContext).toMatchObject({
          dataSourceId: readyWindow.dataSourceId,
          importRunId: `data-source-tracking:${readyWindow.id}`,
          route: readyWindow.route,
          runKind: 'incremental',
        })
        return {acceptedCount: rows.length, importRouteIds: ['route-id-1']}
      },
      trackingRepository: trackingRepository as never,
    })
    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const ingestedWindow = spoolRepository.getWindow(result[0]?.windowId ?? '')
    const pages = spoolRepository.getWindowPages(readyWindow.id)

    expect(result).toMatchObject([{reason: 'ingested', status: 'success'}])
    expect(ingestedWindow?.status).toBe('ingested')
    expect(pages[0]?.duckdbIngestedAt).toBeInstanceOf(Date)
    expect(order).toEqual([
      'duckdb:transaction-background:start',
      'duckdb:store-imported-articles',
      'duckdb:transaction-background:commit',
      'duckdb:transaction-background:start',
      'duckdb:transaction-background:commit',
      'tracking:success',
      'spool:mark-ingested',
    ])
  })
})

test('spool ingester returns capped nonterminal windows to fetch retry after partial ingest', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const window = spoolRepository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: pubmedTrackedImportRoute,
      runKind: 'incremental',
      windowEnd: new Date('2026-09-15T00:00:00.000Z'),
      windowStart: new Date('2026-09-15T00:00:00.000Z'),
    })
    spoolRepository.appendPage({
      cursorAfter: 'cursor-page-1',
      cursorBefore: '*',
      normalizedRecordsJson: [
        {
          articleAuthors: ['Ada Lovelace'],
          articleCreatedAt: '2026-09-15T00:00:00.000Z',
          articleId: 'pmid:1',
          articleSummary: 'Abstract',
          articleTitle: 'Article 1',
          articleUpdatedAt: '2026-09-15T00:00:00.000Z',
          importRoute: pubmedTrackedImportRoute,
        },
      ],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })
    spoolRepository.markWindowReady({spooledAt: new Date('2026-09-16T09:00:00.000Z'), windowId: window.id})

    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          throw new Error('full source recount should not run')
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          throw new Error('full data source update should not run')
        },
      } as never,
      database: {
        transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
          const result = await operation({
            queryJson: async () => {
              return getDataSourceFenceRows()
            },
            run: async () => {
              order.push('duckdb:run')
              return undefined
            },
          })
          return result
        },
      } as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            throw new Error('not used')
          },
          fetchWindowPages: async () => {
            throw new Error('not used')
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            throw new Error('terminal next run should not be computed for a partial window')
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      spoolRepository,
      storeImportedArticlesWithTx: async (_tx, rows: ArticleImportStoreRow[]) => {
        order.push('duckdb:store-imported-articles')
        expect(rows).toHaveLength(1)
        return {acceptedCount: rows.length, importRouteIds: ['route-id-1']}
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordTrackingFailure: async () => {
          throw new Error('tracking failure should not be recorded')
        },
        recordTrackingSuccess: async () => {
          throw new Error('tracking success should wait for terminal fetch')
        },
        updateTrackingState: async () => {
          order.push('tracking:update-next-run')
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const updatedWindow = spoolRepository.getWindow(window.id)
    const pages = spoolRepository.getWindowPages(window.id)

    expect(result).toMatchObject([{reason: 'ingested', status: 'success', windowId: window.id}])
    expect(updatedWindow?.status).toBe('fetch_failed')
    expect(updatedWindow?.cursor).toBe('cursor-page-1')
    expect(updatedWindow?.nextRetryAt).toBeInstanceOf(Date)
    expect(pages[0]?.duckdbIngestedAt).toBeInstanceOf(Date)
    expect(spoolRepository.getWindowPagesBatch({afterPageIndex: -1, limit: 10, windowId: window.id})).toEqual([])
    expect(order).toEqual(['duckdb:store-imported-articles', 'duckdb:run', 'tracking:update-next-run'])
  })
})

test('spool ingester uses reconciliation sync semantics and completes work after DuckDB success', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository, {
      runKind: 'automatic_age_bucket',
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    })
    const originalMarkWindowIngested = spoolRepository.markWindowIngested
    spoolRepository.markWindowIngested = (input) => {
      order.push('spool:mark-ingested')
      return originalMarkWindowIngested(input)
    }
    const database = {
      transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
        order.push('duckdb:transaction-background:start')
        const result = await operation({
          queryJson: async () => {
            return getDataSourceFenceRows()
          },
          run: async () => {
            return undefined
          },
        })
        order.push('duckdb:transaction-background:commit')
        return result
      },
    }
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          order.push('datasource:count-linked')
          return 1
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          order.push('datasource:update-after-import')
          return getDataSource()
        },
      } as never,
      database: database as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          fetchWindowPages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            throw new Error('incremental high-water should not advance for reconciliation')
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      reconciliationWorkRepository: {
        markWorkCompletedForSpoolWindow: async (input: {importRunId?: string | null; spoolWindowId: string}) => {
          order.push(`work:completed:${input.spoolWindowId}:${input.importRunId}`)
          return null
        },
        markWorkFailedForSpoolWindow: async () => {
          order.push('work:failed')
          return null
        },
      } as never,
      spoolRepository,
      finalizeImportedArticlesForReconciliationPeriodWithTx: async (input) => {
        order.push('duckdb:finalize-reconciliation-period')
        expect(input.importRoute).toBe(pubmedTrackedImportRoute)
        expect(input.periodStart.toISOString()).toBe('2026-06-01T00:00:00.000Z')
        expect(input.periodEnd.toISOString()).toBe('2026-07-01T00:00:00.000Z')
        expect(input.sourceRecordKeys).toEqual([])
        expect([...(input.sourceRecordKeyBatches ?? [])].flat()).toEqual(['pmid:1'])
        return {deletedSourceRecordCount: 0, importRouteIds: ['route-id-1']}
      },
      storeImportedArticlesForReconciliationBatchWithTx: async (input) => {
        order.push('duckdb:store-reconciliation-batch')
        expect(input.importRoute).toBe(pubmedTrackedImportRoute)
        expect(input.rows).toHaveLength(1)
        expect(input.changeLogContext).toMatchObject({
          dataSourceId: 'source-1',
          importRunId: `data-source-tracking:${readyWindow.id}`,
          runKind: 'automatic_age_bucket',
        })
        return {acceptedCount: input.rows.length, importRouteIds: ['route-id-1'], sourceRecordKeys: ['pmid:1']}
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordReconciliationSuccess: async (input: {dataSourceId: string; importRunId?: string | null}) => {
          order.push(`tracking:reconciliation-success:${input.dataSourceId}:${input.importRunId}`)
          return null
        },
        recordTrackingFailure: async () => {
          order.push('tracking:failure')
          return null
        },
        recordTrackingSuccess: async () => {
          order.push('tracking:success')
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const ingestedWindow = spoolRepository.getWindow(readyWindow.id)

    expect(result).toMatchObject([{reason: 'ingested', status: 'success'}])
    expect(ingestedWindow?.status).toBe('ingested')
    expect(order).toEqual([
      'duckdb:transaction-background:start',
      'duckdb:store-reconciliation-batch',
      'duckdb:transaction-background:commit',
      'duckdb:transaction-background:start',
      'duckdb:finalize-reconciliation-period',
      'duckdb:transaction-background:commit',
      'duckdb:transaction-background:start',
      'duckdb:transaction-background:commit',
      `work:completed:${readyWindow.id}:data-source-tracking:${readyWindow.id}`,
      `tracking:reconciliation-success:source-1:data-source-tracking:${readyWindow.id}`,
      'spool:mark-ingested',
    ])
  })
})

test('spool ingester stores reconciliation pages in bounded batches before finalizing deletes', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const readyWindow = createReadyWindow(spoolRepository, {
      runKind: 'manual_full_range',
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    })
    spoolRepository.appendPage({
      cursorAfter: null,
      cursorBefore: 'cursor-page-1',
      normalizedRecordsJson: [
        {
          articleCreatedAt: '2026-06-02T00:00:00.000Z',
          articleId: 'pmid:2',
          articleTitle: 'Article 2',
          importRoute: pubmedTrackedImportRoute,
        },
      ],
      pageIndex: 1,
      rawPayloadJson: {page: 2},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-2',
      windowId: readyWindow.id,
    })
    const batchCalls: Array<{afterPageIndex?: number; limit: number}> = []
    const storedBatches: string[][] = []
    const originalGetWindowPagesBatch = spoolRepository.getWindowPagesBatch
    spoolRepository.getWindowPagesBatch = (input) => {
      batchCalls.push({afterPageIndex: input.afterPageIndex, limit: input.limit})
      return originalGetWindowPagesBatch(input)
    }

    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          return 2
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          return getDataSource()
        },
      } as never,
      database: {
        transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
          return await operation({
            queryJson: async () => {
              return getDataSourceFenceRows()
            },
            run: async () => {
              return undefined
            },
          })
        },
      } as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          fetchWindowPages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            return null
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      reconciliationWorkRepository: {
        markWorkCompletedForSpoolWindow: async () => {
          return null
        },
        markWorkFailedForSpoolWindow: async () => {
          return null
        },
      } as never,
      spoolRepository,
      finalizeImportedArticlesForReconciliationPeriodWithTx: async (input) => {
        expect(input.sourceRecordKeys).toEqual([])
        expect([...(input.sourceRecordKeyBatches ?? [])].flat()).toEqual(['pmid:1', 'pmid:2'])
        return {deletedSourceRecordCount: 0, importRouteIds: ['route-id-1']}
      },
      storeImportedArticlesForReconciliationBatchWithTx: async (input) => {
        const batchArticleIds = input.rows.map((row) => {
          return row.articleId
        })
        storedBatches.push(batchArticleIds)
        return {acceptedCount: input.rows.length, importRouteIds: ['route-id-1'], sourceRecordKeys: batchArticleIds}
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordReconciliationSuccess: async () => {
          return null
        },
        recordTrackingFailure: async () => {
          return null
        },
        recordTrackingSuccess: async () => {
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })

    expect(result).toMatchObject([{acceptedCount: 2, pageCount: 2, recordCount: 2, status: 'success'}])
    expect(batchCalls).toEqual([
      {afterPageIndex: -1, limit: 1},
      {afterPageIndex: 0, limit: 1},
      {afterPageIndex: 1, limit: 1},
    ])
    expect(storedBatches).toEqual([['pmid:1'], ['pmid:2']])
  })
})

test('spool ingester fences each page batch against mid-run configuration edits', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const readyWindow = createReadyWindow(spoolRepository, {
      runKind: 'manual_full_range',
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    })
    spoolRepository.appendPage({
      cursorAfter: null,
      cursorBefore: 'cursor-page-1',
      normalizedRecordsJson: [
        {
          articleCreatedAt: '2026-06-02T00:00:00.000Z',
          articleId: 'pmid:2',
          articleTitle: 'Article 2',
          importRoute: pubmedTrackedImportRoute,
        },
      ],
      pageIndex: 1,
      rawPayloadJson: {page: 2},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-2',
      windowId: readyWindow.id,
    })
    let transactionCount = 0
    const storedBatches: string[][] = []
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          return 0
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          return getDataSource()
        },
      } as never,
      database: {
        transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
          transactionCount += 1

          return await operation({
            queryJson: async () => {
              return transactionCount === 1
                ? getDataSourceFenceRows()
                : getDataSourceFenceRows({...getDataSource(), updatedAt: new Date('2026-09-16T10:00:00.000Z')})
            },
            run: async () => {
              return undefined
            },
          })
        },
      } as never,
      reconciliationWorkRepository: {
        markWorkCompletedForSpoolWindow: async () => {
          throw new Error('stale config should not complete reconciliation work')
        },
        markWorkFailedForSpoolWindow: async () => {
          return null
        },
      } as never,
      spoolRepository,
      finalizeImportedArticlesForReconciliationPeriodWithTx: async () => {
        throw new Error('stale config should not finalize reconciliation deletes')
      },
      storeImportedArticlesForReconciliationBatchWithTx: async (input) => {
        storedBatches.push(
          input.rows.map((row) => {
            return row.articleId
          }),
        )
        return {acceptedCount: input.rows.length, importRouteIds: ['route-id-1'], sourceRecordKeys: ['pmid:1']}
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordReconciliationSuccess: async () => {
          throw new Error('stale config should not record reconciliation success')
        },
        recordTrackingFailure: async () => {
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const failedWindow = spoolRepository.getWindow(readyWindow.id)

    expect(result).toMatchObject([
      {
        error: 'Tracked data source configuration changed during spool ingest',
        reason: 'store-failed',
        status: 'failed',
      },
    ])
    expect(storedBatches).toEqual([['pmid:1']])
    expect(failedWindow?.status).toBe('ingest_failed')
  })
})

test('spool ingester rejects stale route windows before DuckDB ingest', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository)
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          order.push('datasource:count-linked')
          return 0
        },
        getDataSourceById: async () => {
          return {...getDataSource(), importRoute: '/api/datasources/import/europe-pmc-ppr'}
        },
        updateDataSourceAfterImport: async () => {
          order.push('datasource:update-after-import')
          return getDataSource()
        },
      } as never,
      database: {
        transactionBackground: async () => {
          order.push('duckdb:transaction')
          throw new Error('stale route should not reach DuckDB')
        },
      } as never,
      spoolRepository,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const rejectedWindow = spoolRepository.getWindow(readyWindow.id)

    expect(result).toMatchObject([{reason: 'stale-route', status: 'failed'}])
    expect(rejectedWindow?.status).toBe('rejected')
    expect(rejectedWindow?.lastError).toContain('no longer matches data source route')
    expect(order).toEqual([])
  })
})

test('spool ingester requires the shared source import lease before DuckDB ingest', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository)
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        getDataSourceById: async () => {
          return getDataSource()
        },
      } as never,
      database: {
        transactionBackground: async () => {
          order.push('duckdb:transaction')
          throw new Error('busy source lease should not reach DuckDB')
        },
      } as never,
      spoolRepository,
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        claimImportLease: async () => {
          order.push('tracking:claim-source-lease')
          return null
        },
        recordTrackingFailure: async () => {
          order.push('tracking:failure')
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const failedWindow = spoolRepository.getWindow(readyWindow.id)

    expect(result).toMatchObject([{reason: 'lease-lost', status: 'failed'}])
    expect(failedWindow?.status).toBe('ingest_failed')
    expect(failedWindow?.nextRetryAt?.toISOString()).toBe('2026-09-16T09:05:00.000Z')
    expect(order).toEqual(['tracking:claim-source-lease'])
  })
})

test('spool ingester rejects stale-bound reconciliation windows without completing work', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository, {
      runKind: 'automatic_age_bucket',
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    })
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          order.push('datasource:count-linked')
          return 0
        },
        getDataSourceById: async () => {
          return {...getDataSource(), dateFrom: new Date('2026-06-15T00:00:00.000Z')}
        },
        updateDataSourceAfterImport: async () => {
          order.push('datasource:update-after-import')
          return getDataSource()
        },
      } as never,
      database: {
        transactionBackground: async () => {
          order.push('duckdb:transaction')
          throw new Error('stale bounds should not reach DuckDB')
        },
      } as never,
      reconciliationWorkRepository: {
        markWorkCompletedForSpoolWindow: async () => {
          order.push('work:completed')
          return null
        },
        markWorkFailedForSpoolWindow: async (input: {
          error: string
          nextRetryAt?: Date | null
          spoolWindowId: string
        }) => {
          order.push(`work:failed:${input.spoolWindowId}:${input.nextRetryAt?.toISOString()}:${input.error}`)
          return null
        },
      } as never,
      spoolRepository,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const rejectedWindow = spoolRepository.getWindow(readyWindow.id)

    expect(result).toMatchObject([{reason: 'stale-bounds', status: 'failed'}])
    expect(rejectedWindow?.status).toBe('rejected')
    expect(rejectedWindow?.lastError).toContain('no longer fits data source bounds')
    expect(order).toHaveLength(1)
    expect(order[0]).toContain(`work:failed:${readyWindow.id}:`)
    expect(order[0]).toContain(':Tracking spool window ')
  })
})

test('spool ingester stops state updates when the ingest lease is lost after DuckDB commit', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    createReadyWindow(spoolRepository)
    const originalRenewWindowLease = spoolRepository.renewWindowLease
    let renewCallCount = 0

    spoolRepository.renewWindowLease = (input) => {
      renewCallCount += 1

      return renewCallCount <= 2 ? originalRenewWindowLease(input) : null
    }

    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          order.push('datasource:count-linked')
          return 1
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          order.push('datasource:update-after-import')
          return getDataSource()
        },
      } as never,
      database: {
        transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
          order.push('duckdb:transaction')
          return await operation({
            queryJson: async () => {
              return getDataSourceFenceRows()
            },
            run: async () => {
              return undefined
            },
          })
        },
      } as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          fetchWindowPages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            return null
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      spoolRepository,
      storeImportedArticlesWithTx: async () => {
        order.push('duckdb:store-imported-articles')
        return {acceptedCount: 1, importRouteIds: ['route-id-1']}
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordTrackingFailure: async () => {
          order.push('tracking:failure')
          return null
        },
        recordTrackingSuccess: async () => {
          order.push('tracking:success')
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })

    expect(result).toMatchObject([{reason: 'lease-lost', status: 'failed'}])
    expect(order).toEqual(['duckdb:transaction', 'duckdb:store-imported-articles'])
  })
})

test('spool ingester preserves a failed window for retry when DuckDB storage fails', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const originalDateNow = Date.now
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository)
    const database = {
      transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
        return await operation({
          queryJson: async () => {
            return getDataSourceFenceRows()
          },
          run: async () => {
            return undefined
          },
        })
      },
    }
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          return 0
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          return getDataSource()
        },
      } as never,
      database: database as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          fetchWindowPages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            return null
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      spoolRepository,
      storeImportedArticlesWithTx: async () => {
        throw new Error('duckdb busy')
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordTrackingFailure: async () => {
          order.push('tracking:failure')
          return null
        },
        recordTrackingSuccess: async () => {
          order.push('tracking:success')
          return null
        },
      } as never,
    })
    Date.now = () => {
      return new Date('2026-09-16T09:30:00.000Z').getTime()
    }

    const result = await ingester
      .drainReadyWindows({
        leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
        leaseOwner: 'ingest-worker',
        limit: 1,
        now: new Date('2026-09-16T09:00:00.000Z'),
      })
      .finally(() => {
        Date.now = originalDateNow
      })
    const failedWindow = spoolRepository.getWindow(readyWindow.id)
    const pages = spoolRepository.getWindowPages(readyWindow.id)

    expect(result).toMatchObject([{error: 'duckdb busy', reason: 'store-failed', status: 'failed'}])
    expect(failedWindow?.status).toBe('ingest_failed')
    expect(failedWindow?.lastError).toBe('duckdb busy')
    expect(failedWindow?.nextRetryAt?.toISOString()).toBe('2026-09-16T09:35:00.000Z')
    expect(pages[0]?.duckdbIngestedAt).toBeNull()
    expect(order).toEqual(['tracking:failure'])
  })
})

test('spool ingester keeps reconciliation work retryable when DuckDB storage fails', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const order: string[] = []
    const readyWindow = createReadyWindow(spoolRepository, {
      runKind: 'automatic_age_bucket',
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    })
    const database = {
      transactionBackground: async <T>(operation: (tx: ArticleImportStoreTx) => Promise<T>) => {
        return await operation({
          queryJson: async () => {
            return getDataSourceFenceRows()
          },
          run: async () => {
            return undefined
          },
        })
      },
    }
    const ingester = createDataSourceTrackingSpoolIngester({
      dataSourceQueryService: {
        countArticlesLinkedToImportRoute: async () => {
          return 0
        },
        getDataSourceById: async () => {
          return getDataSource()
        },
        updateDataSourceAfterImport: async () => {
          return getDataSource()
        },
      } as never,
      database: database as never,
      providerRegistry: createDataSourceTrackingProviderRegistry([
        {
          fetchRangePages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          fetchWindowPages: async () => {
            return {fetchedTotal: 0, pageCount: 0}
          },
          getGranularity: () => {
            return 'day'
          },
          getNextRunAfter: () => {
            return null
          },
          getNextWindow: () => {
            return {nextRunAfter: null, reason: 'complete', status: 'none'}
          },
          getReconciliationRange: () => {
            return {reason: 'empty-range', status: 'none'}
          },
          route: pubmedTrackedImportRoute,
        },
      ]),
      reconciliationWorkRepository: {
        markWorkCompletedForSpoolWindow: async () => {
          order.push('work:completed')
          return null
        },
        markWorkFailedForSpoolWindow: async (input: {error: string; spoolWindowId: string}) => {
          order.push(`work:failed:${input.spoolWindowId}:${input.error}`)
          return null
        },
      } as never,
      spoolRepository,
      storeImportedArticlesForReconciliationBatchWithTx: async () => {
        throw new Error('duckdb busy')
      },
      trackingRepository: {
        ...getTrackingLeaseRepositoryStub(),
        recordReconciliationSuccess: async () => {
          order.push('tracking:reconciliation-success')
          return null
        },
        recordTrackingFailure: async () => {
          order.push('tracking:failure')
          return null
        },
        recordTrackingSuccess: async () => {
          order.push('tracking:success')
          return null
        },
      } as never,
    })

    const result = await ingester.drainReadyWindows({
      leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T09:00:00.000Z'),
    })
    const failedWindow = spoolRepository.getWindow(readyWindow.id)

    expect(result).toMatchObject([{error: 'duckdb busy', reason: 'store-failed', status: 'failed'}])
    expect(failedWindow?.status).toBe('ingest_failed')
    expect(failedWindow?.lastError).toBe('duckdb busy')
    expect(order).toEqual([`work:failed:${readyWindow.id}:duckdb busy`])
  })
})

import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import type {DataSourceRecord} from '../../db/schemaTypes.ts'
import {createDataSourceTrackedImportService} from './dataSourceTrackedImportService.ts'
import {
  createDataSourceTrackingProviderRegistry,
  type DataSourceTrackingProvider,
  type DataSourceTrackingWindow,
  pubmedTrackedImportRoute,
} from './dataSourceTrackingProviderRegistry.ts'
import {createDataSourceTrackingSpoolRepository} from './dataSourceTrackingSpoolRepository.ts'

const getDataSource = (): DataSourceRecord => {
  return {
    archived: false,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    cursor: null,
    dateFrom: new Date('2026-09-14T00:00:00.000Z'),
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

const withSpoolRepository = async <T>(
  operation: (repository: ReturnType<typeof createDataSourceTrackingSpoolRepository>) => Promise<T>,
) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-data-source-tracked-import-'))
  const repository = createDataSourceTrackingSpoolRepository({sqlitePath: join(root, 'tracking-spool.sqlite')})

  try {
    return await operation(repository)
  } finally {
    repository.close()
    rmSync(root, {force: true, recursive: true})
  }
}

test('tracked import fetch spools provider pages into SQLite without a DuckDB dependency', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const fetchCalls: Array<{cursor: string | null | undefined; fromDate: string; toDate: string}> = []
    const provider: DataSourceTrackingProvider = {
      fetchRangePages: async () => {
        throw new Error('not used')
      },
      fetchWindowPages: async ({cursor, fromDate, onPage, toDate}) => {
        fetchCalls.push({cursor, fromDate, toDate})
        await onPage({
          cursorAfter: 'cursor-page-1',
          cursorBefore: '*',
          normalizedRecords: [
            {
              articleAuthors: ['Ada Lovelace'],
              articleId: 'pmid:1',
              articleSummary: 'Abstract',
              articleTitle: 'Article 1',
              importRoute: pubmedTrackedImportRoute,
            },
          ],
          pageIndex: 0,
          rawPage: {page: 1},
          sourceRecordCount: 1,
          sourceRecordHash: 'hash-page-1',
        })
        await onPage({
          cursorAfter: null,
          cursorBefore: 'cursor-page-1',
          normalizedRecords: [
            {
              articleAuthors: ['Grace Hopper'],
              articleId: 'pmid:2',
              articleSummary: 'Abstract',
              articleTitle: 'Article 2',
              importRoute: pubmedTrackedImportRoute,
            },
          ],
          pageIndex: 1,
          rawPage: {page: 2},
          sourceRecordCount: 1,
          sourceRecordHash: 'hash-page-2',
        })

        return {fetchedTotal: 2, pageCount: 2}
      },
      getGranularity: () => {
        return 'day'
      },
      getNextRunAfter: () => {
        return null
      },
      getNextWindow: () => {
        throw new Error('not used')
      },
      getReconciliationRange: () => {
        throw new Error('not used')
      },
      route: pubmedTrackedImportRoute,
    }
    const service = createDataSourceTrackedImportService({
      providerRegistry: createDataSourceTrackingProviderRegistry([provider]),
      spoolRepository,
    })
    const result = await service.fetchWindowToSpool({
      dataSource: getDataSource(),
      now: new Date('2026-09-16T12:00:00.000Z'),
      window: {
        dataSourceId: 'source-1',
        route: pubmedTrackedImportRoute,
        runKind: 'incremental',
        windowEnd: new Date('2026-09-15T00:00:00.000Z'),
        windowStart: new Date('2026-09-15T00:00:00.000Z'),
      },
    })
    const pages = spoolRepository.getWindowPages(result.window.id)

    expect(result.status).toBe('spooled')
    expect(fetchCalls).toEqual([{cursor: null, fromDate: '2026-09-15', toDate: '2026-09-15'}])
    expect(result.window.status).toBe('ready')
    expect(pages).toHaveLength(2)
    expect(pages[0]?.normalizedRecordsJson).toMatchObject([{articleId: 'pmid:1'}])
    expect(pages[1]?.cursorBefore).toBe('cursor-page-1')
  })
})

test('tracked reconciliation fetch spools provider ranges through SQLite cursor resume', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const fetchCalls: Array<{cursor: string | null | undefined; fromDate: string; toDate: string}> = []
    const provider: DataSourceTrackingProvider = {
      fetchRangePages: async ({cursor, fromDate, onPage, toDate}) => {
        fetchCalls.push({cursor, fromDate, toDate})
        await onPage({
          cursorAfter: null,
          cursorBefore: '*',
          normalizedRecords: [
            {
              articleAuthors: ['Ada Lovelace'],
              articleId: 'pmid:1',
              articleSummary: 'Abstract',
              articleTitle: 'Article 1',
              importRoute: pubmedTrackedImportRoute,
            },
          ],
          pageIndex: 0,
          rawPage: {page: 1},
          sourceRecordCount: 1,
          sourceRecordHash: 'hash-page-1',
        })

        return {fetchedTotal: 1, pageCount: 1}
      },
      fetchWindowPages: async () => {
        throw new Error('not used')
      },
      getGranularity: () => {
        return 'day'
      },
      getNextRunAfter: () => {
        return null
      },
      getNextWindow: () => {
        throw new Error('not used')
      },
      getReconciliationRange: () => {
        throw new Error('not used')
      },
      route: pubmedTrackedImportRoute,
    }
    const progress: Array<{cursor: string | null; windowId: string}> = []
    const service = createDataSourceTrackedImportService({
      providerRegistry: createDataSourceTrackingProviderRegistry([provider]),
      spoolRepository,
    })
    const result = await service.fetchReconciliationWorkToSpool({
      dataSource: getDataSource(),
      now: new Date('2026-09-16T12:00:00.000Z'),
      onPageSpooled: ({cursor, window}) => {
        progress.push({cursor, windowId: window.id})
      },
      work: {
        ageMonths: 3,
        completedAt: null,
        cursor: null,
        dataSourceId: 'source-1',
        failureCount: 0,
        id: 'work-1',
        importRunId: null,
        lastError: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        nextRetryAt: null,
        periodEnd: new Date('2026-07-01T00:00:00.000Z'),
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        route: pubmedTrackedImportRoute,
        runKind: 'automatic_age_bucket',
        scheduledAt: new Date('2026-09-01T00:00:00.000Z'),
        spoolWindowId: null,
        startedAt: null,
        status: 'running',
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    })
    const pages = spoolRepository.getWindowPages(result.window.id)

    expect(result.status).toBe('spooled')
    expect(fetchCalls).toEqual([{cursor: null, fromDate: '2026-06-01', toDate: '2026-06-30'}])
    expect(result.window.runKind).toBe('automatic_age_bucket')
    expect(pages).toHaveLength(1)
    expect(progress).toEqual([{cursor: null, windowId: result.window.id}])
  })
})

test('tracked import skips provider refetch when a resumed window is already ready', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    let fetchCallCount = 0
    const provider: DataSourceTrackingProvider = {
      fetchRangePages: async () => {
        throw new Error('not used')
      },
      fetchWindowPages: async () => {
        fetchCallCount += 1
        return {fetchedTotal: 0, pageCount: 0}
      },
      getGranularity: () => {
        return 'day'
      },
      getNextRunAfter: () => {
        return null
      },
      getNextWindow: () => {
        throw new Error('not used')
      },
      getReconciliationRange: () => {
        throw new Error('not used')
      },
      route: pubmedTrackedImportRoute,
    }
    const windowInput: DataSourceTrackingWindow = {
      dataSourceId: 'source-1',
      route: pubmedTrackedImportRoute,
      runKind: 'incremental',
      windowEnd: new Date('2026-09-15T00:00:00.000Z'),
      windowStart: new Date('2026-09-15T00:00:00.000Z'),
    }
    const readyWindow = spoolRepository.createOrResumeWindow(windowInput)
    spoolRepository.markWindowReady({windowId: readyWindow.id})

    const service = createDataSourceTrackedImportService({
      providerRegistry: createDataSourceTrackingProviderRegistry([provider]),
      spoolRepository,
    })
    const result = await service.fetchWindowToSpool({
      dataSource: getDataSource(),
      now: new Date('2026-09-16T12:00:00.000Z'),
      window: windowInput,
    })

    expect(result).toMatchObject({reason: 'already-ready', status: 'skipped'})
    expect(fetchCallCount).toBe(0)
  })
})

test('tracked import marks provider failures as fetch-failed so partial pages are not ingestable', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    const provider: DataSourceTrackingProvider = {
      fetchRangePages: async () => {
        throw new Error('not used')
      },
      fetchWindowPages: async ({onPage}) => {
        await onPage({
          cursorAfter: 'cursor-after-partial-page',
          cursorBefore: '*',
          normalizedRecords: [
            {
              articleAuthors: ['Ada Lovelace'],
              articleId: 'pmid:1',
              articleSummary: 'Abstract',
              articleTitle: 'Article 1',
              importRoute: pubmedTrackedImportRoute,
            },
          ],
          pageIndex: 0,
          rawPage: {page: 1},
          sourceRecordCount: 1,
          sourceRecordHash: 'hash-page-1',
        })
        throw new Error('provider timeout')
      },
      getGranularity: () => {
        return 'day'
      },
      getNextRunAfter: () => {
        return null
      },
      getNextWindow: () => {
        throw new Error('not used')
      },
      getReconciliationRange: () => {
        throw new Error('not used')
      },
      route: pubmedTrackedImportRoute,
    }
    const service = createDataSourceTrackedImportService({
      providerRegistry: createDataSourceTrackingProviderRegistry([provider]),
      spoolRepository,
    })

    try {
      await service.fetchWindowToSpool({
        dataSource: getDataSource(),
        now: new Date('2026-09-16T12:00:00.000Z'),
        window: {
          dataSourceId: 'source-1',
          route: pubmedTrackedImportRoute,
          runKind: 'incremental',
          windowEnd: new Date('2026-09-15T00:00:00.000Z'),
          windowStart: new Date('2026-09-15T00:00:00.000Z'),
        },
      })
      throw new Error('expected provider timeout')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('provider timeout')
    }

    const [window] = spoolRepository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-16T12:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 1,
      now: new Date('2026-09-16T12:05:00.000Z'),
    })
    const partialWindow = spoolRepository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: pubmedTrackedImportRoute,
      runKind: 'incremental',
      windowEnd: new Date('2026-09-15T00:00:00.000Z'),
      windowStart: new Date('2026-09-15T00:00:00.000Z'),
    })

    expect(window).toBeUndefined()
    expect(partialWindow.status).toBe('fetch_failed')
    expect(spoolRepository.getResumeCursor(partialWindow.id)).toBe('cursor-after-partial-page')
  })
})

test('tracked import recovers a terminal spooled page as ready after restart', async () => {
  await withSpoolRepository(async (spoolRepository) => {
    let fetchCallCount = 0
    const provider: DataSourceTrackingProvider = {
      fetchRangePages: async () => {
        throw new Error('not used')
      },
      fetchWindowPages: async () => {
        fetchCallCount += 1
        throw new Error('terminal page should avoid refetch')
      },
      getGranularity: () => {
        return 'day'
      },
      getNextRunAfter: () => {
        return null
      },
      getNextWindow: () => {
        throw new Error('not used')
      },
      getReconciliationRange: () => {
        throw new Error('not used')
      },
      route: pubmedTrackedImportRoute,
    }
    const windowInput: DataSourceTrackingWindow = {
      dataSourceId: 'source-1',
      route: pubmedTrackedImportRoute,
      runKind: 'incremental',
      windowEnd: new Date('2026-09-15T00:00:00.000Z'),
      windowStart: new Date('2026-09-15T00:00:00.000Z'),
    }
    const window = spoolRepository.createOrResumeWindow(windowInput)

    spoolRepository.appendPage({
      cursorAfter: null,
      cursorBefore: 'cursor-before-terminal',
      normalizedRecordsJson: [{articleId: 'pmid:terminal'}],
      pageIndex: 0,
      rawPayloadJson: {page: 'terminal'},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-terminal',
      windowId: window.id,
    })
    spoolRepository.markWindowFailed({
      error: 'process exited before ready',
      nextRetryAt: new Date('2026-09-16T13:00:00.000Z'),
      now: new Date('2026-09-16T12:00:00.000Z'),
      status: 'fetch_failed',
      windowId: window.id,
    })

    const service = createDataSourceTrackedImportService({
      providerRegistry: createDataSourceTrackingProviderRegistry([provider]),
      spoolRepository,
    })
    const result = await service.fetchWindowToSpool({
      dataSource: getDataSource(),
      now: new Date('2026-09-16T12:05:00.000Z'),
      window: windowInput,
    })

    expect(result.status).toBe('spooled')
    expect(result.window.status).toBe('ready')
    expect(result.pageCount).toBe(1)
    expect(fetchCallCount).toBe(0)
  })
})

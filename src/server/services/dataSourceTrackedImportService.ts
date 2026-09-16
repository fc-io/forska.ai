import {createHash} from 'node:crypto'

import type {DataSourceReconciliationWorkRecord, DataSourceRecord} from '../../db/schemaTypes.ts'
import {
  type DataSourceTrackingProviderRegistry,
  type DataSourceTrackingWindow,
  formatUtcDay,
  getDataSourceTrackingProviderRegistry,
} from './dataSourceTrackingProviderRegistry.ts'
import {
  createDataSourceTrackingSpoolRepository,
  type DataSourceTrackingSpoolWindowRecord,
  getDataSourceTrackingSpoolRepository,
} from './dataSourceTrackingSpoolRepository.ts'

export type DataSourceTrackedImportResult =
  | {
      fetchedTotal: number
      pageCount: number
      reason: 'fetched'
      status: 'spooled'
      window: DataSourceTrackingSpoolWindowRecord
    }
  | {
      reason:
        | 'already-ingest-failed'
        | 'already-ingested'
        | 'already-ready'
        | 'already-rejected'
        | 'already-ingesting'
        | 'retry-not-due'
      status: 'skipped'
      window: DataSourceTrackingSpoolWindowRecord
    }

export type DataSourceTrackedImportService = {
  fetchReconciliationWorkToSpool: (input: {
    dataSource: DataSourceRecord
    assertPageAppendAllowed?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    now?: Date
    onPageSpooled?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    onSpoolWindowCreated?: (window: DataSourceTrackingSpoolWindowRecord) => Promise<void> | void
    maxPendingPagesBeforeReady?: number
    work: DataSourceReconciliationWorkRecord
  }) => Promise<DataSourceTrackedImportResult>
  fetchWindowToSpool: (input: {
    dataSource: DataSourceRecord
    assertPageAppendAllowed?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    now?: Date
    onPageSpooled?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    onSpoolWindowCreated?: (window: DataSourceTrackingSpoolWindowRecord) => Promise<void> | void
    maxPendingPagesBeforeReady?: number
    window: DataSourceTrackingWindow
  }) => Promise<DataSourceTrackedImportResult>
}

type DataSourceTrackingSpoolRepository = ReturnType<typeof createDataSourceTrackingSpoolRepository>

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getStableJsonValue = (value: unknown): string => {
  return value instanceof Date
    ? JSON.stringify(value.toISOString())
    : Array.isArray(value)
      ? `[${value
          .map((entry) => {
            return getStableJsonValue(entry)
          })
          .join(',')}]`
      : value !== null && typeof value === 'object'
        ? `{${Object.keys(value)
            .sort((left, right) => {
              return left.localeCompare(right)
            })
            .map((key) => {
              return `${JSON.stringify(key)}:${getStableJsonValue((value as Record<string, unknown>)[key])}`
            })
            .join(',')}}`
        : (JSON.stringify(value) ?? 'null')
}

const getEmptyPageHash = () => {
  return createHash('sha256').update(getStableJsonValue([])).digest('hex')
}

const getRetryBaseNow = (startedAt: Date) => {
  return new Date(Math.max(Date.now(), startedAt.getTime()))
}

const getInclusiveRangeEnd = (periodStart: Date, periodEnd: Date) => {
  const startDay = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()))
  const endDay = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()))
  const inclusiveEnd = new Date(endDay.getTime() - 24 * 60 * 60 * 1000)

  return inclusiveEnd.getTime() < startDay.getTime() ? startDay : inclusiveEnd
}

class DataSourceTrackingPartialWindowReadyError extends Error {
  constructor() {
    super('Tracking spool window reached the page cap and is ready for partial ingest')
  }
}

export const createDataSourceTrackedImportService = ({
  providerRegistry = getDataSourceTrackingProviderRegistry(),
  spoolRepository = getDataSourceTrackingSpoolRepository(),
}: {
  providerRegistry?: DataSourceTrackingProviderRegistry
  spoolRepository?: DataSourceTrackingSpoolRepository
} = {}): DataSourceTrackedImportService => {
  const fetchToSpool = async ({
    assertPageAppendAllowed,
    dataSource,
    fetchRange,
    maxPendingPagesBeforeReady,
    now,
    onPageSpooled,
    onSpoolWindowCreated,
    route,
    runKind,
    spoolWindowId,
    windowEnd,
    windowStart,
  }: {
    assertPageAppendAllowed?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    dataSource: DataSourceRecord
    fetchRange: boolean
    maxPendingPagesBeforeReady?: number
    now: Date
    onPageSpooled?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    onSpoolWindowCreated?: (window: DataSourceTrackingSpoolWindowRecord) => Promise<void> | void
    route: string
    runKind: DataSourceTrackingSpoolWindowRecord['runKind']
    spoolWindowId?: string
    windowEnd: Date
    windowStart: Date
  }): Promise<DataSourceTrackedImportResult> => {
    const provider = providerRegistry.getProvider(route)

    if (!provider) {
      throw new Error(`Unsupported data source tracking route: ${route}`)
    }

    const spoolWindow = spoolRepository.createOrResumeWindow({
      dataSourceId: dataSource.id,
      id: spoolWindowId,
      now,
      route,
      runKind,
      windowEnd,
      windowStart,
    })
    await onSpoolWindowCreated?.(spoolWindow)

    if (spoolWindow.status === 'ingested') {
      return {reason: 'already-ingested', status: 'skipped', window: spoolWindow}
    }

    if (spoolWindow.status === 'ready') {
      return {reason: 'already-ready', status: 'skipped', window: spoolWindow}
    }

    if (spoolWindow.status === 'ingesting') {
      return {reason: 'already-ingesting', status: 'skipped', window: spoolWindow}
    }

    if (spoolWindow.status === 'ingest_failed') {
      return {reason: 'already-ingest-failed', status: 'skipped', window: spoolWindow}
    }

    if (spoolWindow.status === 'rejected') {
      return {reason: 'already-rejected', status: 'skipped', window: spoolWindow}
    }

    const existingPages = spoolRepository.getWindowPages(spoolWindow.id)
    const existingPendingPages = existingPages.filter((page) => {
      return page.duckdbIngestedAt === null
    })
    const existingTerminalPage = existingPages.at(-1)

    if (
      existingPages.length > 0
      && existingTerminalPage?.cursorAfter === null
      && (spoolWindow.status === 'fetching' || spoolWindow.status === 'fetch_failed')
    ) {
      const readyWindow = spoolRepository.markWindowReady({spooledAt: new Date(), windowId: spoolWindow.id})

      if (!readyWindow) {
        throw new Error('Tracking spool window disappeared before it could be marked ready')
      }

      return {
        fetchedTotal: existingPages.reduce((sum, page) => {
          return sum + page.sourceRecordCount
        }, 0),
        pageCount: existingPages.length,
        reason: 'fetched',
        status: 'spooled',
        window: readyWindow,
      }
    }

    if (spoolWindow.status === 'fetch_failed' && spoolWindow.nextRetryAt && spoolWindow.nextRetryAt > now) {
      return {reason: 'retry-not-due', status: 'skipped', window: spoolWindow}
    }

    if (
      maxPendingPagesBeforeReady
      && maxPendingPagesBeforeReady > 0
      && existingPendingPages.length >= maxPendingPagesBeforeReady
      && spoolWindow.cursor !== null
    ) {
      const readyWindow = spoolRepository.markWindowReady({spooledAt: new Date(), windowId: spoolWindow.id})

      if (!readyWindow) {
        throw new Error('Tracking spool window disappeared before it could be marked ready')
      }

      return {
        fetchedTotal: existingPendingPages.reduce((sum, page) => {
          return sum + page.sourceRecordCount
        }, 0),
        pageCount: existingPendingPages.length,
        reason: 'fetched',
        status: 'spooled',
        window: readyWindow,
      }
    }

    const resumeCursor = spoolRepository.getResumeCursor(spoolWindow.id)
    const existingPageCount = existingPages.length

    try {
      const fetchPages = fetchRange ? provider.fetchRangePages : provider.fetchWindowPages
      const fetchResult = await fetchPages({
        cursor: resumeCursor,
        fromDate: formatUtcDay(windowStart),
        importRoute: route,
        onPage: async (page) => {
          await assertPageAppendAllowed?.({cursor: page.cursorAfter, window: spoolWindow})
          spoolRepository.appendPage({
            cursorAfter: page.cursorAfter,
            cursorBefore: page.cursorBefore,
            fetchedAt: new Date(),
            normalizedRecordsJson: page.normalizedRecords,
            pageIndex: existingPageCount + page.pageIndex,
            rawPayloadJson: page.rawPage,
            sourceRecordCount: page.sourceRecordCount,
            sourceRecordHash: page.sourceRecordHash || getEmptyPageHash(),
            windowId: spoolWindow.id,
          })
          await onPageSpooled?.({cursor: page.cursorAfter, window: spoolWindow})

          if (
            page.cursorAfter !== null
            && maxPendingPagesBeforeReady
            && maxPendingPagesBeforeReady > 0
            && spoolRepository.getWindowPages(spoolWindow.id).filter((spooledPage) => {
              return spooledPage.duckdbIngestedAt === null
            }).length >= maxPendingPagesBeforeReady
          ) {
            throw new DataSourceTrackingPartialWindowReadyError()
          }
        },
        toDate: formatUtcDay(fetchRange ? getInclusiveRangeEnd(windowStart, windowEnd) : windowEnd),
      })
      const readyWindow = spoolRepository.markWindowReady({spooledAt: new Date(), windowId: spoolWindow.id})

      if (!readyWindow) {
        throw new Error('Tracking spool window disappeared before it could be marked ready')
      }

      return {
        fetchedTotal: fetchResult.fetchedTotal,
        pageCount: fetchResult.pageCount,
        reason: 'fetched',
        status: 'spooled',
        window: readyWindow,
      }
    } catch (error) {
      if (error instanceof DataSourceTrackingPartialWindowReadyError) {
        const readyWindow = spoolRepository.markWindowReady({spooledAt: new Date(), windowId: spoolWindow.id})
        const pendingPages = spoolRepository.getWindowPages(spoolWindow.id).filter((page) => {
          return page.duckdbIngestedAt === null
        })

        if (!readyWindow) {
          throw new Error('Tracking spool window disappeared before it could be marked ready')
        }

        return {
          fetchedTotal: pendingPages.reduce((sum, page) => {
            return sum + page.sourceRecordCount
          }, 0),
          pageCount: pendingPages.length,
          reason: 'fetched',
          status: 'spooled',
          window: readyWindow,
        }
      }

      const failureNow = getRetryBaseNow(now)
      spoolRepository.markWindowFailed({
        error: getErrorMessage(error),
        nextRetryAt: new Date(failureNow.getTime() + 5 * 60 * 1000),
        now: failureNow,
        status: 'fetch_failed',
        windowId: spoolWindow.id,
      })
      throw error
    }
  }

  const fetchWindowToSpool: DataSourceTrackedImportService['fetchWindowToSpool'] = async ({
    assertPageAppendAllowed,
    dataSource,
    now = new Date(),
    onPageSpooled,
    onSpoolWindowCreated,
    maxPendingPagesBeforeReady,
    window,
  }) => {
    return await fetchToSpool({
      dataSource,
      assertPageAppendAllowed,
      fetchRange: false,
      maxPendingPagesBeforeReady,
      now,
      onPageSpooled,
      onSpoolWindowCreated,
      route: window.route,
      runKind: window.runKind,
      windowEnd: window.windowEnd,
      windowStart: window.windowStart,
    })
  }

  const fetchReconciliationWorkToSpool: DataSourceTrackedImportService['fetchReconciliationWorkToSpool'] = async ({
    assertPageAppendAllowed,
    dataSource,
    now = new Date(),
    onPageSpooled,
    onSpoolWindowCreated,
    maxPendingPagesBeforeReady,
    work,
  }) => {
    return await fetchToSpool({
      dataSource,
      assertPageAppendAllowed,
      fetchRange: true,
      maxPendingPagesBeforeReady,
      now,
      onPageSpooled,
      onSpoolWindowCreated,
      route: work.route,
      runKind: work.runKind,
      spoolWindowId: work.id,
      windowEnd: work.periodEnd,
      windowStart: work.periodStart,
    })
  }

  return {fetchReconciliationWorkToSpool, fetchWindowToSpool}
}

let cachedDataSourceTrackedImportService: DataSourceTrackedImportService | null = null

export const getDataSourceTrackedImportService = () => {
  cachedDataSourceTrackedImportService ??= createDataSourceTrackedImportService()

  return cachedDataSourceTrackedImportService
}

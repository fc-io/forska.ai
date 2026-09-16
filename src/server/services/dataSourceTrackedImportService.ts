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
      reason: 'already-ingest-failed' | 'already-ingested' | 'already-ready' | 'already-ingesting' | 'retry-not-due'
      status: 'skipped'
      window: DataSourceTrackingSpoolWindowRecord
    }

export type DataSourceTrackedImportService = {
  fetchReconciliationWorkToSpool: (input: {
    dataSource: DataSourceRecord
    now?: Date
    onPageSpooled?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    onSpoolWindowCreated?: (window: DataSourceTrackingSpoolWindowRecord) => Promise<void> | void
    work: DataSourceReconciliationWorkRecord
  }) => Promise<DataSourceTrackedImportResult>
  fetchWindowToSpool: (input: {
    dataSource: DataSourceRecord
    now?: Date
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

const getInclusiveRangeEnd = (periodStart: Date, periodEnd: Date) => {
  const startDay = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()))
  const endDay = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()))
  const inclusiveEnd = new Date(endDay.getTime() - 24 * 60 * 60 * 1000)

  return inclusiveEnd.getTime() < startDay.getTime() ? startDay : inclusiveEnd
}

export const createDataSourceTrackedImportService = ({
  providerRegistry = getDataSourceTrackingProviderRegistry(),
  spoolRepository = getDataSourceTrackingSpoolRepository(),
}: {
  providerRegistry?: DataSourceTrackingProviderRegistry
  spoolRepository?: DataSourceTrackingSpoolRepository
} = {}): DataSourceTrackedImportService => {
  const fetchToSpool = async ({
    dataSource,
    fetchRange,
    now,
    onPageSpooled,
    onSpoolWindowCreated,
    route,
    runKind,
    windowEnd,
    windowStart,
  }: {
    dataSource: DataSourceRecord
    fetchRange: boolean
    now: Date
    onPageSpooled?: (input: {
      cursor: string | null
      window: DataSourceTrackingSpoolWindowRecord
    }) => Promise<void> | void
    onSpoolWindowCreated?: (window: DataSourceTrackingSpoolWindowRecord) => Promise<void> | void
    route: string
    runKind: DataSourceTrackingSpoolWindowRecord['runKind']
    windowEnd: Date
    windowStart: Date
  }): Promise<DataSourceTrackedImportResult> => {
    const provider = providerRegistry.getProvider(route)

    if (!provider) {
      throw new Error(`Unsupported data source tracking route: ${route}`)
    }

    const spoolWindow = spoolRepository.createOrResumeWindow({
      dataSourceId: dataSource.id,
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

    if (spoolWindow.status === 'fetch_failed' && spoolWindow.nextRetryAt && spoolWindow.nextRetryAt > now) {
      return {reason: 'retry-not-due', status: 'skipped', window: spoolWindow}
    }

    const resumeCursor = spoolRepository.getResumeCursor(spoolWindow.id)
    const existingPageCount = spoolRepository.getWindowPages(spoolWindow.id).length

    try {
      const fetchPages = fetchRange ? provider.fetchRangePages : provider.fetchWindowPages
      const fetchResult = await fetchPages({
        cursor: resumeCursor,
        fromDate: formatUtcDay(windowStart),
        importRoute: route,
        onPage: async (page) => {
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
      spoolRepository.markWindowFailed({
        error: getErrorMessage(error),
        nextRetryAt: new Date(now.getTime() + 5 * 60 * 1000),
        now,
        status: 'fetch_failed',
        windowId: spoolWindow.id,
      })
      throw error
    }
  }

  const fetchWindowToSpool: DataSourceTrackedImportService['fetchWindowToSpool'] = async ({
    dataSource,
    now = new Date(),
    window,
  }) => {
    return await fetchToSpool({
      dataSource,
      fetchRange: false,
      now,
      route: window.route,
      runKind: window.runKind,
      windowEnd: window.windowEnd,
      windowStart: window.windowStart,
    })
  }

  const fetchReconciliationWorkToSpool: DataSourceTrackedImportService['fetchReconciliationWorkToSpool'] = async ({
    dataSource,
    now = new Date(),
    onPageSpooled,
    onSpoolWindowCreated,
    work,
  }) => {
    return await fetchToSpool({
      dataSource,
      fetchRange: true,
      now,
      onPageSpooled,
      onSpoolWindowCreated,
      route: work.route,
      runKind: work.runKind,
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

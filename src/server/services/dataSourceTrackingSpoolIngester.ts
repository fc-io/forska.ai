import type {DataSourceRecord} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import type {ArticleImportStoreRow, ArticleImportStoreTx} from './articleImportStoreService.ts'
import {
  articleImportStoreWorkloadContext,
  finalizeImportedArticlesForReconciliationPeriodWithTx as defaultFinalizeImportedArticlesForReconciliationPeriodWithTx,
  storeImportedArticlesForReconciliationBatchWithTx as defaultStoreImportedArticlesForReconciliationBatchWithTx,
  storeImportedArticlesWithTx as defaultStoreImportedArticlesWithTx,
} from './articleImportStoreService.ts'
import {getDataSourceQueryService} from './dataSourceQueryService.ts'
import {
  type DataSourceTrackingProviderRegistry,
  getDataSourceTrackingProviderRegistry,
} from './dataSourceTrackingProviderRegistry.ts'
import {
  createDataSourceReconciliationWorkRepository,
  createDataSourceTrackingRepository,
} from './dataSourceTrackingRepository.ts'
import {
  createDataSourceTrackingSpoolRepository,
  type DataSourceTrackingSpoolPageRecord,
  type DataSourceTrackingSpoolWindowRecord,
  getDataSourceTrackingSpoolRepository,
} from './dataSourceTrackingSpoolRepository.ts'

type DataSourceQueryService = ReturnType<typeof getDataSourceQueryService>
type DataSourceTrackingRepository = ReturnType<typeof createDataSourceTrackingRepository>
type DataSourceReconciliationWorkRepository = ReturnType<typeof createDataSourceReconciliationWorkRepository>
type DataSourceTrackingSpoolRepository = ReturnType<typeof createDataSourceTrackingSpoolRepository>
type AppDatabaseService = ReturnType<typeof getAppDatabaseService>

export type DataSourceTrackingSpoolIngestResult =
  | {
      acceptedCount: number
      importRunId: string
      pageCount: number
      reason: 'ingested'
      recordCount: number
      status: 'success'
      windowId: string
    }
  | {
      error: string
      reason:
        | 'data-source-missing'
        | 'lease-lost'
        | 'provider-missing'
        | 'stale-bounds'
        | 'stale-route'
        | 'store-failed'
        | 'tracking-disabled'
      status: 'failed'
      windowId: string
    }

export type DataSourceTrackingSpoolIngester = {
  drainReadyWindows: (input?: {
    leaseExpiresAt?: Date
    leaseOwner?: string
    limit?: number
    now?: Date
  }) => Promise<DataSourceTrackingSpoolIngestResult[]>
}

const defaultIngestLimit = 2
const defaultLeaseDurationMs = 5 * 60 * 1000
const defaultPageBatchSize = 1
const defaultRetryDelayMs = 5 * 60 * 1000
const millisecondsPerDay = 24 * 60 * 60 * 1000

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getUtcDayStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

const addUtcDays = (date: Date, days: number) => {
  return new Date(getUtcDayStart(date).getTime() + days * millisecondsPerDay)
}

const isUsableDate = (date: Date | null | undefined): date is Date => {
  return date instanceof Date && !Number.isNaN(date.getTime())
}

class SpoolIngestLeaseLostError extends Error {
  constructor() {
    super('Tracking spool ingest lease lost')
  }
}

const getLeaseRenewalIntervalMs = (leaseDurationMs: number) => {
  return Math.max(1000, Math.min(60_000, Math.floor(leaseDurationMs / 2)))
}

const getDateOrNull = (value: unknown) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

const reviveArticleImportStoreRow = (row: unknown, importRunId: string): ArticleImportStoreRow | null => {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return null
  }

  const record = row as ArticleImportStoreRow

  return {
    ...record,
    articleCreatedAt: getDateOrNull(record.articleCreatedAt) ?? record.articleCreatedAt,
    articleUpdatedAt: getDateOrNull(record.articleUpdatedAt) ?? record.articleUpdatedAt,
    fullTextFetchedAt: getDateOrNull(record.fullTextFetchedAt) ?? record.fullTextFetchedAt,
    importRunId: record.importRunId ?? importRunId,
  }
}

const getNormalizedRecordsFromPages = (
  pages: DataSourceTrackingSpoolPageRecord[],
  importRunId: string,
): ArticleImportStoreRow[] => {
  return pages.flatMap((page) => {
    const pageRows = Array.isArray(page.normalizedRecordsJson) ? page.normalizedRecordsJson : []

    return pageRows.flatMap((row) => {
      const revived = reviveArticleImportStoreRow(row, importRunId)

      return revived ? [revived] : []
    })
  })
}

const getImportRunId = (window: DataSourceTrackingSpoolWindowRecord) => {
  return `data-source-tracking:${window.id}`
}

const getWindowExclusiveEnd = (window: DataSourceTrackingSpoolWindowRecord) => {
  return window.runKind === 'incremental' ? addUtcDays(window.windowEnd, 1) : window.windowEnd
}

const isWindowWithinDataSourceBounds = (window: DataSourceTrackingSpoolWindowRecord, dataSource: DataSourceRecord) => {
  const dateFrom = isUsableDate(dataSource.dateFrom) ? getUtcDayStart(dataSource.dateFrom) : null
  const endExclusive = isUsableDate(dataSource.dateTo) ? addUtcDays(dataSource.dateTo, 1) : null

  if (dateFrom && window.windowStart.getTime() < dateFrom.getTime()) {
    return false
  }

  return !endExclusive || getWindowExclusiveEnd(window).getTime() <= endExclusive.getTime()
}

export const createDataSourceTrackingSpoolIngester = ({
  dataSourceQueryService = getDataSourceQueryService(),
  database = getAppDatabaseService(),
  finalizeImportedArticlesForReconciliationPeriodWithTx = defaultFinalizeImportedArticlesForReconciliationPeriodWithTx,
  providerRegistry = getDataSourceTrackingProviderRegistry(),
  reconciliationWorkRepository = createDataSourceReconciliationWorkRepository(),
  spoolRepository = getDataSourceTrackingSpoolRepository(),
  storeImportedArticlesForReconciliationBatchWithTx = defaultStoreImportedArticlesForReconciliationBatchWithTx,
  storeImportedArticlesWithTx = defaultStoreImportedArticlesWithTx,
  trackingRepository = createDataSourceTrackingRepository(),
}: {
  dataSourceQueryService?: DataSourceQueryService
  database?: AppDatabaseService
  finalizeImportedArticlesForReconciliationPeriodWithTx?: (input: {
    changeLogContext?: {
      dataSourceId: string
      detectedAt?: Date
      importRunId: string | null
      route: string
      runKind: 'automatic_age_bucket' | 'manual_full_range'
    } | null
    importRoute: string
    periodEnd: Date
    periodStart: Date
    sourceRecordKeyBatches?: Iterable<string[]>
    sourceRecordKeys: string[]
    tx: ArticleImportStoreTx
  }) => Promise<{deletedSourceRecordCount: number; importRouteIds: string[]}>
  providerRegistry?: DataSourceTrackingProviderRegistry
  reconciliationWorkRepository?: DataSourceReconciliationWorkRepository
  spoolRepository?: DataSourceTrackingSpoolRepository
  storeImportedArticlesForReconciliationBatchWithTx?: (input: {
    changeLogContext?: {
      dataSourceId: string
      detectedAt?: Date
      importRunId: string | null
      route: string
      runKind: 'automatic_age_bucket' | 'manual_full_range'
    } | null
    importRoute: string
    rows: ArticleImportStoreRow[]
    tx: ArticleImportStoreTx
  }) => Promise<{acceptedCount: number; importRouteIds: string[]; sourceRecordKeys: string[]}>
  storeImportedArticlesWithTx?: (
    tx: ArticleImportStoreTx,
    rows: ArticleImportStoreRow[],
  ) => Promise<{acceptedCount: number; importRouteIds: string[]}>
  trackingRepository?: DataSourceTrackingRepository
} = {}): DataSourceTrackingSpoolIngester => {
  const ingestWindow = async (
    window: DataSourceTrackingSpoolWindowRecord,
    leaseOwner: string,
    now: Date,
  ): Promise<DataSourceTrackingSpoolIngestResult> => {
    const importRunId = getImportRunId(window)
    const leaseDurationMs = Math.max(
      1000,
      (window.leaseExpiresAt?.getTime() ?? now.getTime() + defaultLeaseDurationMs) - now.getTime(),
    )
    let leaseLostError: SpoolIngestLeaseLostError | null = null
    const renewWindowLease = () => {
      if (leaseLostError) {
        throw leaseLostError
      }

      const renewalNow = new Date()
      const renewed = spoolRepository.renewWindowLease({
        leaseExpiresAt: new Date(renewalNow.getTime() + leaseDurationMs),
        leaseOwner,
        now: renewalNow,
        windowId: window.id,
      })

      if (!renewed) {
        leaseLostError = new SpoolIngestLeaseLostError()
        throw leaseLostError
      }

      return renewed
    }
    const startLeaseRenewal = () => {
      const timer = setInterval(() => {
        try {
          renewWindowLease()
        } catch (error) {
          leaseLostError ??= error instanceof SpoolIngestLeaseLostError ? error : new SpoolIngestLeaseLostError()
        }
      }, getLeaseRenewalIntervalMs(leaseDurationMs))
      const maybeUnrefTimer = timer as {unref?: () => void}

      maybeUnrefTimer.unref?.()

      return timer
    }
    const rejectWindow = async (
      reason: 'stale-bounds' | 'stale-route' | 'tracking-disabled',
      error: string,
    ): Promise<DataSourceTrackingSpoolIngestResult> => {
      const failureNow = new Date()
      const nextRetryAt = new Date(failureNow.getTime() + defaultRetryDelayMs)

      spoolRepository.markWindowRejected({error, now: failureNow, windowId: window.id})
      if (window.runKind !== 'incremental') {
        await reconciliationWorkRepository.markWorkFailedForSpoolWindow({
          error,
          nextRetryAt,
          now: failureNow,
          spoolWindowId: window.id,
        })
      }

      return {error, reason, status: 'failed', windowId: window.id}
    }
    const dataSource = await dataSourceQueryService.getDataSourceById(window.dataSourceId)

    if (!dataSource) {
      const error = 'Data source not found'
      spoolRepository.markWindowFailed({
        error,
        nextRetryAt: new Date(now.getTime() + defaultRetryDelayMs),
        now,
        windowId: window.id,
      })
      if (window.runKind !== 'incremental') {
        await reconciliationWorkRepository.markWorkFailedForSpoolWindow({
          error,
          nextRetryAt: new Date(now.getTime() + defaultRetryDelayMs),
          now,
          spoolWindowId: window.id,
        })
      }
      return {error, reason: 'data-source-missing', status: 'failed', windowId: window.id}
    }

    if (dataSource.archived || !dataSource.trackingEnabled) {
      return await rejectWindow(
        'tracking-disabled',
        dataSource.archived
          ? 'Tracked data source is archived'
          : 'Continuous tracking is not enabled for this data source',
      )
    }

    if (dataSource.importRoute !== window.route) {
      return await rejectWindow(
        'stale-route',
        `Tracking spool route ${window.route} no longer matches data source route ${dataSource.importRoute ?? 'none'}`,
      )
    }

    if (!isWindowWithinDataSourceBounds(window, dataSource)) {
      return await rejectWindow(
        'stale-bounds',
        `Tracking spool window ${window.windowStart.toISOString()}..${window.windowEnd.toISOString()} no longer fits data source bounds`,
      )
    }

    const provider = providerRegistry.getProvider(window.route)

    if (!provider) {
      const error = `Unsupported data source tracking route: ${window.route}`
      spoolRepository.markWindowFailed({
        error,
        nextRetryAt: new Date(now.getTime() + defaultRetryDelayMs),
        now,
        windowId: window.id,
      })
      if (window.runKind === 'incremental') {
        await trackingRepository.recordTrackingFailure({
          dataSourceId: window.dataSourceId,
          error,
          nextRunAfter: new Date(now.getTime() + defaultRetryDelayMs),
          now,
        })
      } else {
        await reconciliationWorkRepository.markWorkFailedForSpoolWindow({
          error,
          nextRetryAt: new Date(now.getTime() + defaultRetryDelayMs),
          now,
          spoolWindowId: window.id,
        })
      }
      return {error, reason: 'provider-missing', status: 'failed', windowId: window.id}
    }

    const transaction = database.transactionBackground ?? database.transaction
    let leaseRenewalTimer: ReturnType<typeof setInterval> | null = null

    try {
      renewWindowLease()
      leaseRenewalTimer = startLeaseRenewal()
      let acceptedCount = 0
      let pageCount = 0
      let recordCount = 0
      let afterPageIndex = -1

      while (true) {
        renewWindowLease()
        const pageBatch = spoolRepository.getWindowPagesBatch({
          afterPageIndex,
          limit: defaultPageBatchSize,
          windowId: window.id,
        })

        if (pageBatch.length === 0) {
          break
        }

        const records = getNormalizedRecordsFromPages(pageBatch, importRunId)
        const storeResult = await transaction(async (tx) => {
          if (window.runKind === 'incremental') {
            return {...(await storeImportedArticlesWithTx(tx, records)), sourceRecordKeys: []}
          }

          return await storeImportedArticlesForReconciliationBatchWithTx({
            changeLogContext: {
              dataSourceId: window.dataSourceId,
              importRunId,
              route: window.route,
              runKind: window.runKind,
            },
            importRoute: window.route,
            rows: records,
            tx,
          })
        }, articleImportStoreWorkloadContext)

        if (window.runKind !== 'incremental') {
          spoolRepository.recordWindowSourceRecordKeys({
            sourceRecordKeys: storeResult.sourceRecordKeys,
            windowId: window.id,
          })
        }

        acceptedCount += storeResult.acceptedCount
        pageCount += pageBatch.length
        recordCount += records.length
        afterPageIndex = pageBatch.at(-1)?.pageIndex ?? afterPageIndex
      }

      if (window.runKind !== 'incremental') {
        const sourceRecordKeyBatches = function* () {
          let afterSourceRecordKey: string | null = null

          while (true) {
            const sourceRecordKeyBatch = spoolRepository.getWindowSourceRecordKeysBatch({
              afterSourceRecordKey,
              limit: 1000,
              windowId: window.id,
            })

            if (sourceRecordKeyBatch.length === 0) {
              break
            }

            yield sourceRecordKeyBatch
            afterSourceRecordKey = sourceRecordKeyBatch.at(-1) ?? afterSourceRecordKey
          }
        }

        renewWindowLease()
        await transaction(async (tx) => {
          return await finalizeImportedArticlesForReconciliationPeriodWithTx({
            changeLogContext: {
              dataSourceId: window.dataSourceId,
              importRunId,
              route: window.route,
              runKind: window.runKind,
            },
            importRoute: window.route,
            periodEnd: window.windowEnd,
            periodStart: window.windowStart,
            sourceRecordKeyBatches: sourceRecordKeyBatches(),
            sourceRecordKeys: [],
            tx,
          })
        }, articleImportStoreWorkloadContext)
      }

      clearInterval(leaseRenewalTimer)
      leaseRenewalTimer = null
      renewWindowLease()
      const importedCount = await dataSourceQueryService.countArticlesLinkedToImportRoute({
        dateFrom: dataSource.dateFrom,
        dateTo: dataSource.dateTo,
        route: window.route,
      })

      renewWindowLease()
      await dataSourceQueryService.updateDataSourceAfterImport({
        cursor: null,
        id: dataSource.id,
        importRoute: window.route,
        importedCount,
      })

      renewWindowLease()
      if (window.runKind === 'incremental') {
        await trackingRepository.recordTrackingSuccess({
          dataSourceId: window.dataSourceId,
          highWaterCompletedAt: window.windowEnd,
          importRunId,
          nextRunAfter: provider.getNextRunAfter({
            completedWindow: {
              dataSourceId: window.dataSourceId,
              route: provider.route,
              runKind: 'incremental',
              windowEnd: window.windowEnd,
              windowStart: window.windowStart,
            },
            dataSource,
            now,
          }),
          now,
        })
      } else {
        await reconciliationWorkRepository.markWorkCompletedForSpoolWindow({importRunId, now, spoolWindowId: window.id})
        await trackingRepository.recordReconciliationSuccess({dataSourceId: window.dataSourceId, importRunId, now})
      }

      renewWindowLease()
      const ingestedWindow = spoolRepository.markWindowIngested({
        ingestedAt: new Date(),
        leaseOwner,
        windowId: window.id,
      })

      if (ingestedWindow?.status !== 'ingested') {
        throw new SpoolIngestLeaseLostError()
      }

      return {
        acceptedCount,
        importRunId,
        pageCount,
        reason: 'ingested',
        recordCount,
        status: 'success',
        windowId: window.id,
      }
    } catch (error) {
      if (leaseRenewalTimer) {
        clearInterval(leaseRenewalTimer)
      }

      const errorMessage = getErrorMessage(error)
      const nextRetryAt = new Date(now.getTime() + defaultRetryDelayMs)

      if (error instanceof SpoolIngestLeaseLostError) {
        return {error: errorMessage, reason: 'lease-lost', status: 'failed', windowId: window.id}
      }

      spoolRepository.markWindowFailed({error: errorMessage, nextRetryAt, now, windowId: window.id})
      if (window.runKind === 'incremental') {
        await trackingRepository.recordTrackingFailure({
          dataSourceId: window.dataSourceId,
          error: errorMessage,
          nextRunAfter: nextRetryAt,
          now,
        })
      } else {
        await reconciliationWorkRepository.markWorkFailedForSpoolWindow({
          error: errorMessage,
          nextRetryAt,
          now,
          spoolWindowId: window.id,
        })
      }

      return {error: errorMessage, reason: 'store-failed', status: 'failed', windowId: window.id}
    }
  }

  const drainReadyWindows: DataSourceTrackingSpoolIngester['drainReadyWindows'] = async (input = {}) => {
    const now = input.now ?? new Date()
    const leaseOwner = input.leaseOwner ?? `data-source-tracking-ingester:${process.pid}`
    const windows = spoolRepository.claimReadyWindowsForIngest({
      leaseExpiresAt: input.leaseExpiresAt ?? new Date(now.getTime() + defaultLeaseDurationMs),
      leaseOwner,
      limit: input.limit ?? defaultIngestLimit,
      now,
    })
    const results: DataSourceTrackingSpoolIngestResult[] = []

    for (const window of windows) {
      results.push(await ingestWindow(window, leaseOwner, now))
    }

    return results
  }

  return {drainReadyWindows}
}

let cachedDataSourceTrackingSpoolIngester: DataSourceTrackingSpoolIngester | null = null

export const getDataSourceTrackingSpoolIngester = () => {
  cachedDataSourceTrackingSpoolIngester ??= createDataSourceTrackingSpoolIngester()

  return cachedDataSourceTrackingSpoolIngester
}

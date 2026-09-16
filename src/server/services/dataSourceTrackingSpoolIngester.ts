import {getAppDatabaseService} from './appDatabaseService.ts'
import type {ArticleImportStoreRow, ArticleImportStoreTx} from './articleImportStoreService.ts'
import {
  articleImportStoreWorkloadContext,
  storeImportedArticlesWithTx as defaultStoreImportedArticlesWithTx,
  syncImportedArticlesForReconciliationPeriodWithTx as defaultSyncImportedArticlesForReconciliationPeriodWithTx,
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
      reason: 'data-source-missing' | 'provider-missing' | 'store-failed'
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
const defaultRetryDelayMs = 5 * 60 * 1000

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
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

export const createDataSourceTrackingSpoolIngester = ({
  dataSourceQueryService = getDataSourceQueryService(),
  database = getAppDatabaseService(),
  providerRegistry = getDataSourceTrackingProviderRegistry(),
  reconciliationWorkRepository = createDataSourceReconciliationWorkRepository(),
  spoolRepository = getDataSourceTrackingSpoolRepository(),
  storeImportedArticlesWithTx = defaultStoreImportedArticlesWithTx,
  syncImportedArticlesForReconciliationPeriodWithTx = defaultSyncImportedArticlesForReconciliationPeriodWithTx,
  trackingRepository = createDataSourceTrackingRepository(),
}: {
  dataSourceQueryService?: DataSourceQueryService
  database?: AppDatabaseService
  providerRegistry?: DataSourceTrackingProviderRegistry
  reconciliationWorkRepository?: DataSourceReconciliationWorkRepository
  spoolRepository?: DataSourceTrackingSpoolRepository
  storeImportedArticlesWithTx?: (
    tx: ArticleImportStoreTx,
    rows: ArticleImportStoreRow[],
  ) => Promise<{acceptedCount: number; importRouteIds: string[]}>
  syncImportedArticlesForReconciliationPeriodWithTx?: (input: {
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
    rows: ArticleImportStoreRow[]
    tx: ArticleImportStoreTx
  }) => Promise<{acceptedCount: number; deletedSourceRecordCount: number; importRouteIds: string[]}>
  trackingRepository?: DataSourceTrackingRepository
} = {}): DataSourceTrackingSpoolIngester => {
  const ingestWindow = async (
    window: DataSourceTrackingSpoolWindowRecord,
    leaseOwner: string,
    now: Date,
  ): Promise<DataSourceTrackingSpoolIngestResult> => {
    const importRunId = getImportRunId(window)
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

    const pages = spoolRepository.getWindowPages(window.id)
    const records = getNormalizedRecordsFromPages(pages, importRunId)
    const transaction = database.transactionBackground ?? database.transaction

    try {
      const storeResult = await transaction(async (tx) => {
        return window.runKind === 'incremental'
          ? await storeImportedArticlesWithTx(tx, records)
          : await syncImportedArticlesForReconciliationPeriodWithTx({
              changeLogContext: {
                dataSourceId: window.dataSourceId,
                importRunId,
                route: window.route,
                runKind: window.runKind,
              },
              importRoute: window.route,
              periodEnd: window.windowEnd,
              periodStart: window.windowStart,
              rows: records,
              tx,
            })
      }, articleImportStoreWorkloadContext)
      const importedCount = await dataSourceQueryService.countArticlesLinkedToImportRoute({
        dateFrom: dataSource.dateFrom,
        dateTo: dataSource.dateTo,
        route: window.route,
      })

      await dataSourceQueryService.updateDataSourceAfterImport({
        cursor: null,
        id: dataSource.id,
        importRoute: window.route,
        importedCount,
      })

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

      spoolRepository.markWindowIngested({ingestedAt: new Date(), leaseOwner, windowId: window.id})

      return {
        acceptedCount: storeResult.acceptedCount,
        importRunId,
        pageCount: pages.length,
        reason: 'ingested',
        recordCount: records.length,
        status: 'success',
        windowId: window.id,
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      const nextRetryAt = new Date(now.getTime() + defaultRetryDelayMs)

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

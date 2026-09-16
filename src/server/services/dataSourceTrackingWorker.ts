import {randomUUID} from 'node:crypto'

import type {
  DataSourceReconciliationWorkRecord,
  DataSourceRecord,
  DataSourceTrackingStateRecord,
} from '../../db/schemaTypes.ts'
import {getDataSourceQueryService} from './dataSourceQueryService.ts'
import {
  type DataSourceTrackedImportService,
  getDataSourceTrackedImportService,
} from './dataSourceTrackedImportService.ts'
import {
  type DataSourceTrackingProviderRegistry,
  getDataSourceTrackingProviderRegistry,
  supportedTrackedImportRoutes,
} from './dataSourceTrackingProviderRegistry.ts'
import {
  createDataSourceReconciliationWorkRepository,
  createDataSourceTrackingRepository,
} from './dataSourceTrackingRepository.ts'
import {
  type DataSourceTrackingSpoolIngester,
  getDataSourceTrackingSpoolIngester,
} from './dataSourceTrackingSpoolIngester.ts'
import {
  createDataSourceTrackingSpoolRepository,
  getDataSourceTrackingSpoolRepository,
} from './dataSourceTrackingSpoolRepository.ts'

type DataSourceQueryService = ReturnType<typeof getDataSourceQueryService>
type DataSourceReconciliationWorkRepository = ReturnType<typeof createDataSourceReconciliationWorkRepository>
type DataSourceTrackingRepository = ReturnType<typeof createDataSourceTrackingRepository>
type DataSourceTrackingSpoolRepository = ReturnType<typeof createDataSourceTrackingSpoolRepository>

export type DataSourceTrackingWorkerSourceResult =
  | {dataSourceId: string; reason: 'backpressure'; status: 'skipped'}
  | {dataSourceId: string; reason: 'claim-lost'; status: 'skipped'}
  | {dataSourceId: string; reason: 'data-source-missing' | 'provider-missing'; status: 'failed'}
  | {dataSourceId: string; reason: 'complete' | 'missing-date-from' | 'waiting-for-closed-day'; status: 'skipped'}
  | {
      dataSourceId: string
      pageCount?: number
      reason:
        | 'fetched'
        | 'already-ingested'
        | 'already-ready'
        | 'already-rejected'
        | 'already-ingesting'
        | 'retry-not-due'
      status: 'spooled' | 'skipped'
      windowId: string
    }
  | {dataSourceId: string; error: string; reason: 'fetch-failed'; status: 'failed'; windowId?: string}

export type DataSourceTrackingWorkerReconciliationResult =
  | {dataSourceId: string; reason: 'backpressure'; status: 'skipped'; workId: string}
  | {dataSourceId: string; reason: 'data-source-missing' | 'provider-missing'; status: 'failed'; workId: string}
  | {
      dataSourceId: string
      pageCount?: number
      reason:
        | 'fetched'
        | 'already-ingested'
        | 'already-ready'
        | 'already-rejected'
        | 'already-ingesting'
        | 'retry-not-due'
      status: 'spooled' | 'skipped'
      windowId: string
      workId: string
    }
  | {dataSourceId: string; error: string; reason: 'fetch-failed'; status: 'failed'; windowId?: string; workId: string}

export type DataSourceTrackingWorkerWakeResult = {
  backpressureActive: boolean
  claimedSourceCount: number
  dueSourceCount: number
  ingestedWindowCount: number
  ingestResults: Awaited<ReturnType<DataSourceTrackingSpoolIngester['drainReadyWindows']>>
  reconciliationResults: DataSourceTrackingWorkerReconciliationResult[]
  reason: 'ran'
  scheduledReconciliationCount: number
  sourceResults: DataSourceTrackingWorkerSourceResult[]
}

export type DataSourceTrackingWorker = {
  wake: (input?: {
    fetchLeaseMs?: number
    ingestLeaseMs?: number
    ingestLimit?: number
    maxFetchSources?: number
    maxPendingPages?: number
    maxPendingWindows?: number
    maxReconciliationWork?: number
    now?: Date
  }) => Promise<DataSourceTrackingWorkerWakeResult>
}

type Logger = {
  log: (message?: unknown, ...optionalParams: unknown[]) => void
  warn: (message?: unknown, ...optionalParams: unknown[]) => void
}

const defaultMaxFetchSources = 2
const defaultMaxReconciliationWork = 2
const defaultIngestLimit = 2
const defaultFetchLeaseMs = 10 * 60 * 1000
const defaultIngestLeaseMs = 5 * 60 * 1000
const defaultMaxPendingPages = 20
const defaultMaxPendingWindows = 5
const defaultFailureRetryMs = 5 * 60 * 1000
const defaultSpoolCleanupAgeMs = 24 * 60 * 60 * 1000
const defaultSpoolCleanupLimit = 100

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getLeaseRenewalIntervalMs = (leaseDurationMs: number) => {
  return Math.max(1000, Math.min(60_000, Math.floor(leaseDurationMs / 2)))
}

const getRetryBaseNow = (startedAt: Date) => {
  return new Date(Math.max(Date.now(), startedAt.getTime()))
}

const withLeaseRenewal = async <T>({
  leaseDurationMs,
  operation,
  renewLease,
}: {
  leaseDurationMs: number
  operation: (controls: {assertLeaseOwned: () => Promise<void>}) => Promise<T>
  renewLease: (input: {leaseExpiresAt: Date; now: Date}) => Promise<unknown>
}) => {
  let leaseLostError: Error | null = null
  const renew = async () => {
    if (leaseLostError) {
      return
    }

    const renewalNow = new Date()
    const renewed = await renewLease({
      leaseExpiresAt: new Date(renewalNow.getTime() + leaseDurationMs),
      now: renewalNow,
    })

    if (renewed === null) {
      leaseLostError = new Error('Data source tracking lease lost')
    }
  }
  const assertLeaseOwned = async () => {
    await renew()

    if (leaseLostError) {
      throw leaseLostError
    }
  }

  await assertLeaseOwned()

  if (leaseLostError) {
    throw leaseLostError
  }

  const timer = setInterval(() => {
    void renew().catch((error) => {
      leaseLostError ??= error instanceof Error ? error : new Error(String(error))
    })
  }, getLeaseRenewalIntervalMs(leaseDurationMs))
  const maybeUnrefTimer = timer as {unref?: () => void}

  maybeUnrefTimer.unref?.()

  try {
    const result = await operation({assertLeaseOwned})

    if (leaseLostError) {
      throw leaseLostError
    }

    return result
  } finally {
    clearInterval(timer)
  }
}

const getClaimedSourceResult = async ({
  dataSource,
  fetchLeaseMs,
  assertSpoolCapacity,
  leaseOwner,
  maxPendingPages,
  now,
  providerRegistry,
  state,
  trackedImportService,
  trackingRepository,
}: {
  dataSource: DataSourceRecord
  fetchLeaseMs: number
  assertSpoolCapacity: () => Promise<void> | void
  maxPendingPages: number
  leaseOwner: string
  now: Date
  providerRegistry: DataSourceTrackingProviderRegistry
  state: DataSourceTrackingStateRecord
  trackedImportService: DataSourceTrackedImportService
  trackingRepository: DataSourceTrackingRepository
}): Promise<DataSourceTrackingWorkerSourceResult> => {
  const provider = providerRegistry.getProvider(state.route)

  if (!provider) {
    await trackingRepository.recordTrackingFailure({
      dataSourceId: state.dataSourceId,
      error: `Unsupported data source tracking route: ${state.route}`,
      leaseOwner,
      nextRunAfter: new Date(now.getTime() + defaultFailureRetryMs),
      now,
    })
    return {dataSourceId: state.dataSourceId, reason: 'provider-missing', status: 'failed'}
  }

  const selection = provider.getNextWindow({dataSource, now, state})

  if (selection.status === 'none') {
    if (selection.reason === 'missing-date-from') {
      await trackingRepository.recordTrackingFailure({
        dataSourceId: state.dataSourceId,
        error: 'Tracked data source is missing date_from',
        leaseOwner,
        nextRunAfter: selection.nextRunAfter,
        now,
      })
    } else {
      await trackingRepository.updateTrackingState(state.dataSourceId, {nextRunAfter: selection.nextRunAfter}, now)
      await trackingRepository.releaseSourceLease({dataSourceId: state.dataSourceId, leaseOwner, now})
    }

    return {dataSourceId: state.dataSourceId, reason: selection.reason, status: 'skipped'}
  }

  const startedState = await trackingRepository.startTrackingWindow({
    dataSourceId: state.dataSourceId,
    runKind: selection.window.runKind,
    windowEnd: selection.window.windowEnd,
    windowStart: selection.window.windowStart,
  })

  if (!startedState) {
    await trackingRepository.recordTrackingFailure({
      dataSourceId: state.dataSourceId,
      error: 'Failed to start tracking window',
      leaseOwner,
      nextRunAfter: new Date(now.getTime() + defaultFailureRetryMs),
      now,
    })
    return {
      dataSourceId: state.dataSourceId,
      error: 'Failed to start tracking window',
      reason: 'fetch-failed',
      status: 'failed',
    }
  }

  try {
    const result = await withLeaseRenewal({
      leaseDurationMs: fetchLeaseMs,
      operation: async ({assertLeaseOwned}) => {
        return await trackedImportService.fetchWindowToSpool({
          assertPageAppendAllowed: async () => {
            await assertLeaseOwned()
            await assertSpoolCapacity()
            await assertLeaseOwned()
          },
          dataSource,
          maxPendingPagesBeforeReady: maxPendingPages,
          now,
          onPageSpooled: async ({cursor}) => {
            await assertLeaseOwned()
            await trackingRepository.updateTrackingState(state.dataSourceId, {activeCursor: cursor}, new Date())
            await assertLeaseOwned()
          },
          window: selection.window,
        })
      },
      renewLease: async ({leaseExpiresAt, now: renewalNow}) => {
        return await trackingRepository.renewSourceLease({
          dataSourceId: state.dataSourceId,
          leaseExpiresAt,
          leaseOwner,
          now: renewalNow,
        })
      },
    })

    await trackingRepository.releaseSourceLease({dataSourceId: state.dataSourceId, leaseOwner, now})

    return {
      dataSourceId: state.dataSourceId,
      pageCount: result.status === 'spooled' ? result.pageCount : undefined,
      reason: result.reason,
      status: result.status === 'spooled' ? 'spooled' : 'skipped',
      windowId: result.window.id,
    }
  } catch (error) {
    const failureNow = getRetryBaseNow(now)
    const message = getErrorMessage(error)
    const activeState = await trackingRepository.getTrackingState(state.dataSourceId)

    await trackingRepository.recordTrackingFailure({
      dataSourceId: state.dataSourceId,
      error: message,
      leaseOwner,
      nextRunAfter: new Date(failureNow.getTime() + defaultFailureRetryMs),
      now: failureNow,
    })

    return {
      dataSourceId: state.dataSourceId,
      error: message,
      reason: 'fetch-failed',
      status: 'failed',
      windowId: activeState?.activeWindowStart ? `${activeState.activeWindowStart.toISOString()}` : undefined,
    }
  }
}

const getClaimedReconciliationResult = async ({
  dataSource,
  fetchLeaseMs,
  assertSpoolCapacity,
  leaseOwner,
  maxPendingPages,
  now,
  providerRegistry,
  reconciliationWorkRepository,
  trackingRepository,
  trackedImportService,
  work,
}: {
  dataSource: DataSourceRecord
  fetchLeaseMs: number
  assertSpoolCapacity: () => Promise<void> | void
  maxPendingPages: number
  leaseOwner: string
  now: Date
  providerRegistry: DataSourceTrackingProviderRegistry
  reconciliationWorkRepository: DataSourceReconciliationWorkRepository
  trackingRepository: DataSourceTrackingRepository
  trackedImportService: DataSourceTrackedImportService
  work: DataSourceReconciliationWorkRecord
}): Promise<DataSourceTrackingWorkerReconciliationResult> => {
  const provider = providerRegistry.getProvider(work.route)

  if (!provider) {
    await reconciliationWorkRepository.markWorkFailed({
      error: `Unsupported data source tracking route: ${work.route}`,
      id: work.id,
      leaseOwner,
      nextRetryAt: new Date(now.getTime() + defaultFailureRetryMs),
      now,
    })
    return {dataSourceId: work.dataSourceId, reason: 'provider-missing', status: 'failed', workId: work.id}
  }

  try {
    await trackingRepository.startTrackingWindow({
      activeCursor: work.cursor,
      ageMonths: work.ageMonths,
      dataSourceId: work.dataSourceId,
      runKind: 'reconciliation',
      windowEnd: work.periodEnd,
      windowStart: work.periodStart,
    })
    const result = await withLeaseRenewal({
      leaseDurationMs: fetchLeaseMs,
      operation: async ({assertLeaseOwned}) => {
        return await trackedImportService.fetchReconciliationWorkToSpool({
          assertPageAppendAllowed: async () => {
            await assertLeaseOwned()
            await assertSpoolCapacity()
            await assertLeaseOwned()
          },
          dataSource,
          maxPendingPagesBeforeReady: maxPendingPages,
          now,
          onPageSpooled: async ({cursor, window}) => {
            await assertLeaseOwned()
            await reconciliationWorkRepository.updateWorkSpoolProgress({
              cursor,
              id: work.id,
              now,
              spoolWindowId: window.id,
            })
            await trackingRepository.updateTrackingState(work.dataSourceId, {activeCursor: cursor}, new Date())
            await assertLeaseOwned()
          },
          onSpoolWindowCreated: async (window) => {
            await assertLeaseOwned()
            await reconciliationWorkRepository.updateWorkSpoolProgress({
              cursor: window.cursor,
              id: work.id,
              now,
              spoolWindowId: window.id,
            })
            await trackingRepository.updateTrackingState(work.dataSourceId, {activeCursor: window.cursor}, new Date())
            await assertLeaseOwned()
          },
          work,
        })
      },
      renewLease: async ({leaseExpiresAt, now: renewalNow}) => {
        return await reconciliationWorkRepository.renewWorkLease({
          id: work.id,
          leaseExpiresAt,
          leaseOwner,
          now: renewalNow,
        })
      },
    })

    await reconciliationWorkRepository.updateWorkSpoolProgress({
      cursor: result.window.cursor,
      id: work.id,
      now,
      spoolWindowId: result.window.id,
    })

    return {
      dataSourceId: work.dataSourceId,
      pageCount: result.status === 'spooled' ? result.pageCount : undefined,
      reason: result.reason,
      status: result.status === 'spooled' ? 'spooled' : 'skipped',
      windowId: result.window.id,
      workId: work.id,
    }
  } catch (error) {
    const failureNow = getRetryBaseNow(now)
    const message = getErrorMessage(error)

    await reconciliationWorkRepository.markWorkFailed({
      error: message,
      id: work.id,
      leaseOwner,
      nextRetryAt: new Date(failureNow.getTime() + defaultFailureRetryMs),
      now: failureNow,
    })
    await trackingRepository.recordTrackingFailure({
      dataSourceId: work.dataSourceId,
      error: message,
      nextRunAfter: null,
      now: failureNow,
    })

    return {
      dataSourceId: work.dataSourceId,
      error: message,
      reason: 'fetch-failed',
      status: 'failed',
      windowId: work.spoolWindowId ?? undefined,
      workId: work.id,
    }
  }
}

export const createDataSourceTrackingWorker = ({
  dataSourceQueryService = getDataSourceQueryService(),
  logger = console,
  providerRegistry = getDataSourceTrackingProviderRegistry(),
  reconciliationWorkRepository = createDataSourceReconciliationWorkRepository(),
  spoolIngester = getDataSourceTrackingSpoolIngester(),
  spoolRepository = getDataSourceTrackingSpoolRepository(),
  trackedImportService = getDataSourceTrackedImportService(),
  trackingRepository = createDataSourceTrackingRepository(),
}: {
  dataSourceQueryService?: DataSourceQueryService
  logger?: Logger
  providerRegistry?: DataSourceTrackingProviderRegistry
  reconciliationWorkRepository?: DataSourceReconciliationWorkRepository
  spoolIngester?: DataSourceTrackingSpoolIngester
  spoolRepository?: DataSourceTrackingSpoolRepository
  trackedImportService?: DataSourceTrackedImportService
  trackingRepository?: DataSourceTrackingRepository
} = {}): DataSourceTrackingWorker => {
  const wake: DataSourceTrackingWorker['wake'] = async (input = {}) => {
    const now = input.now ?? new Date()
    const maxFetchSources = input.maxFetchSources ?? defaultMaxFetchSources
    const maxReconciliationWork = input.maxReconciliationWork ?? defaultMaxReconciliationWork
    const maxPendingPages = input.maxPendingPages ?? defaultMaxPendingPages
    const maxPendingWindows = input.maxPendingWindows ?? defaultMaxPendingWindows
    const fetchLeaseMs = input.fetchLeaseMs ?? defaultFetchLeaseMs
    const ingestLeaseMs = input.ingestLeaseMs ?? defaultIngestLeaseMs
    const workerRunId = randomUUID()
    const leaseOwner = `data-source-tracking:${process.pid}:${workerRunId}`
    const scheduledReconciliationWork = await reconciliationWorkRepository.scheduleDueMonthlyAgeBucketWork({
      now,
      routes: [...supportedTrackedImportRoutes],
    })
    let backpressureSignal = spoolRepository.getBackpressureSignal({maxPendingPages, maxPendingWindows})
    const refreshBackpressureSignal = () => {
      backpressureSignal = spoolRepository.getBackpressureSignal({maxPendingPages, maxPendingWindows})

      return backpressureSignal
    }
    const assertSpoolCapacity = () => {
      const signal = spoolRepository.getBackpressureSignal({maxPendingPages, maxPendingWindows})

      backpressureSignal = signal

      if (signal.backpressureActive) {
        throw new Error('Tracking spool backpressure is active')
      }
    }
    const dueSources = await trackingRepository.selectDueSources({
      limit: maxFetchSources,
      now,
      routes: [...supportedTrackedImportRoutes],
    })
    const sourceResults: DataSourceTrackingWorkerSourceResult[] = []
    const reconciliationResults: DataSourceTrackingWorkerReconciliationResult[] = []
    let claimedSourceCount = 0

    for (const dueSource of dueSources) {
      if (
        refreshBackpressureSignal().backpressureActive
        && !spoolRepository.hasRetryableFetchFailedWindow({dataSourceId: dueSource.dataSourceId, now})
      ) {
        sourceResults.push({dataSourceId: dueSource.dataSourceId, reason: 'backpressure', status: 'skipped'})
        continue
      }

      const claim = await trackingRepository.claimDueSource({
        dataSourceId: dueSource.dataSourceId,
        leaseExpiresAt: new Date(now.getTime() + fetchLeaseMs),
        leaseOwner,
        now,
      })

      if (!claim) {
        sourceResults.push({dataSourceId: dueSource.dataSourceId, reason: 'claim-lost', status: 'skipped'})
        continue
      }

      claimedSourceCount += 1

      const dataSource = await dataSourceQueryService.getDataSourceById(claim.dataSourceId)

      if (!dataSource) {
        await trackingRepository.recordTrackingFailure({
          dataSourceId: claim.dataSourceId,
          error: 'Data source not found',
          leaseOwner,
          nextRunAfter: new Date(now.getTime() + defaultFailureRetryMs),
          now,
        })
        sourceResults.push({dataSourceId: claim.dataSourceId, reason: 'data-source-missing', status: 'failed'})
        continue
      }

      sourceResults.push(
        await getClaimedSourceResult({
          dataSource,
          fetchLeaseMs,
          assertSpoolCapacity,
          leaseOwner,
          maxPendingPages,
          now,
          providerRegistry,
          state: claim,
          trackedImportService,
          trackingRepository,
        }),
      )
    }

    const canClaimReconciliationWork = () => {
      const signal = refreshBackpressureSignal()

      return !signal.backpressureActive || spoolRepository.hasRetryableFetchFailedWindow({now})
    }

    if (canClaimReconciliationWork()) {
      for (let index = 0; index < maxReconciliationWork; index += 1) {
        if (!canClaimReconciliationWork()) {
          break
        }

        const work = await reconciliationWorkRepository.claimNextWork({
          leaseExpiresAt: new Date(now.getTime() + fetchLeaseMs),
          leaseOwner,
          now,
        })

        if (!work) {
          break
        }

        const dataSource = await dataSourceQueryService.getDataSourceById(work.dataSourceId)

        if (!dataSource) {
          await reconciliationWorkRepository.markWorkFailed({
            error: 'Data source not found',
            id: work.id,
            leaseOwner,
            nextRetryAt: new Date(now.getTime() + defaultFailureRetryMs),
            now,
          })
          reconciliationResults.push({
            dataSourceId: work.dataSourceId,
            reason: 'data-source-missing',
            status: 'failed',
            workId: work.id,
          })
          continue
        }

        reconciliationResults.push(
          await getClaimedReconciliationResult({
            dataSource,
            fetchLeaseMs,
            assertSpoolCapacity,
            leaseOwner,
            maxPendingPages,
            now,
            providerRegistry,
            reconciliationWorkRepository,
            trackingRepository,
            trackedImportService,
            work,
          }),
        )
      }
    }

    const ingestResults = await spoolIngester.drainReadyWindows({
      leaseExpiresAt: new Date(now.getTime() + ingestLeaseMs),
      leaseOwner: `${leaseOwner}:ingest`,
      limit: input.ingestLimit ?? defaultIngestLimit,
      now,
    })
    const cleanupIngested = (
      spoolRepository as {
        cleanupIngested?: (input: {ingestedBefore: Date; limit: number}) => {
          pagesDeleted: number
          windowsDeleted: number
        }
      }
    ).cleanupIngested

    if (cleanupIngested) {
      try {
        cleanupIngested({
          ingestedBefore: new Date(now.getTime() - defaultSpoolCleanupAgeMs),
          limit: defaultSpoolCleanupLimit,
        })
      } catch (error) {
        logger.warn('[data-source-tracking] failed to clean up ingested spool payloads', {
          error: getErrorMessage(error),
        })
      }
    }
    const ingestedWindowCount = ingestResults.filter((result) => {
      return result.status === 'success'
    }).length
    const result = {
      backpressureActive: backpressureSignal.backpressureActive,
      claimedSourceCount,
      dueSourceCount: dueSources.length,
      ingestedWindowCount,
      ingestResults,
      reconciliationResults,
      reason: 'ran' as const,
      scheduledReconciliationCount: scheduledReconciliationWork.length,
      sourceResults,
    }

    logger.log('[data-source-tracking] worker wake complete', {
      backpressureActive: result.backpressureActive,
      claimedSourceCount: result.claimedSourceCount,
      dueSourceCount: result.dueSourceCount,
      failedSourceCount: sourceResults.filter((sourceResult) => {
        return sourceResult.status === 'failed'
      }).length,
      failedReconciliationCount: reconciliationResults.filter((reconciliationResult) => {
        return reconciliationResult.status === 'failed'
      }).length,
      ingestedWindowCount: result.ingestedWindowCount,
      scheduledReconciliationCount: result.scheduledReconciliationCount,
      spooledWindowCount:
        sourceResults.filter((sourceResult) => {
          return sourceResult.status === 'spooled'
        }).length
        + reconciliationResults.filter((reconciliationResult) => {
          return reconciliationResult.status === 'spooled'
        }).length,
    })

    return result
  }

  return {wake}
}

let cachedDataSourceTrackingWorker: DataSourceTrackingWorker | null = null

export const getDataSourceTrackingWorker = () => {
  cachedDataSourceTrackingWorker ??= createDataSourceTrackingWorker()

  return cachedDataSourceTrackingWorker
}

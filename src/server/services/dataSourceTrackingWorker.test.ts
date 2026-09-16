import {expect, test} from 'bun:test'

import type {DataSourceTrackingStateRecord} from '../../db/schemaTypes.ts'
import {pubmedTrackedImportRoute} from './dataSourceTrackingProviderRegistry.ts'
import {createDataSourceTrackingWorker} from './dataSourceTrackingWorker.ts'

const getState = (): DataSourceTrackingStateRecord => {
  return {
    activeCursor: null,
    activeReconciliationAgeMonths: null,
    activeRunKind: null,
    activeWindowEnd: null,
    activeWindowStart: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    dataSourceId: 'source-1',
    failureCount: 0,
    granularity: 'day',
    highWaterCompletedAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastImportRunId: null,
    lastReconciliationCompletedAt: null,
    lastReconciliationSchedulerAt: null,
    lastSuccessAt: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    nextRunAfter: null,
    route: pubmedTrackedImportRoute,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  }
}

test('data source tracking worker skips fetch claims under spool backpressure but still drains ingest', async () => {
  let claimCallCount = 0
  let reconciliationClaimCallCount = 0
  let drainCallCount = 0
  const worker = createDataSourceTrackingWorker({
    logger: {
      log: () => {
        return undefined
      },
      warn: () => {
        return undefined
      },
    },
    spoolIngester: {
      drainReadyWindows: async () => {
        drainCallCount += 1
        return []
      },
    },
    spoolRepository: {
      getBackpressureSignal: () => {
        return {
          backpressureActive: true,
          backlog: {
            failedWindowCount: 0,
            oldestReadyAt: new Date('2026-09-16T09:00:00.000Z'),
            pendingPageCount: 20,
            pendingWindowCount: 5,
            readyWindowCount: 5,
          },
        }
      },
    } as never,
    reconciliationWorkRepository: {
      claimNextWork: async () => {
        reconciliationClaimCallCount += 1
        return null
      },
      scheduleDueMonthlyAgeBucketWork: async () => {
        return []
      },
    } as never,
    trackingRepository: {
      claimDueSource: async () => {
        claimCallCount += 1
        return null
      },
      selectDueSources: async () => {
        return [getState()]
      },
    } as never,
  })

  const result = await worker.wake({now: new Date('2026-09-16T09:00:00.000Z')})

  expect(result.backpressureActive).toBe(true)
  expect(result.claimedSourceCount).toBe(0)
  expect(result.sourceResults).toEqual([{dataSourceId: 'source-1', reason: 'backpressure', status: 'skipped'}])
  expect(claimCallCount).toBe(0)
  expect(reconciliationClaimCallCount).toBe(0)
  expect(drainCallCount).toBe(1)
})

test('data source tracking worker claims and spools reconciliation work separately from incremental sources', async () => {
  const calls: string[] = []
  const now = new Date('2026-09-16T09:00:00.000Z')
  const work = {
    ageMonths: 3,
    completedAt: null,
    cursor: null,
    dataSourceId: 'source-1',
    failureCount: 0,
    id: 'work-1',
    importRunId: null,
    lastError: null,
    leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
    leaseOwner: 'worker',
    nextRetryAt: null,
    periodEnd: new Date('2026-07-01T00:00:00.000Z'),
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    route: pubmedTrackedImportRoute,
    runKind: 'automatic_age_bucket' as const,
    scheduledAt: new Date('2026-09-01T00:00:00.000Z'),
    spoolWindowId: null,
    startedAt: now,
    status: 'running' as const,
    updatedAt: now,
  }
  let claimCount = 0
  const worker = createDataSourceTrackingWorker({
    dataSourceQueryService: {
      getDataSourceById: async () => {
        calls.push('datasource:get')
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
          trackingReconcileScheduleMonths: [3],
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        }
      },
    } as never,
    logger: {
      log: () => {
        return undefined
      },
      warn: () => {
        return undefined
      },
    },
    providerRegistry: {
      getProvider: () => {
        return {route: pubmedTrackedImportRoute}
      },
    } as never,
    reconciliationWorkRepository: {
      claimNextWork: async () => {
        claimCount += 1
        calls.push('reconciliation:claim')
        return claimCount === 1 ? work : null
      },
      markWorkFailed: async () => {
        calls.push('reconciliation:failed')
        return null
      },
      scheduleDueMonthlyAgeBucketWork: async () => {
        calls.push('reconciliation:schedule')
        return []
      },
      updateWorkSpoolProgress: async () => {
        calls.push('reconciliation:progress')
        return null
      },
    } as never,
    spoolIngester: {
      drainReadyWindows: async () => {
        calls.push('spool:drain')
        return []
      },
    },
    spoolRepository: {
      getBackpressureSignal: () => {
        return {
          backpressureActive: false,
          backlog: {
            failedWindowCount: 0,
            oldestReadyAt: null,
            pendingPageCount: 0,
            pendingWindowCount: 0,
            readyWindowCount: 0,
          },
        }
      },
    } as never,
    trackedImportService: {
      fetchReconciliationWorkToSpool: async (input: {
        onPageSpooled?: (input: {
          cursor: string | null
          window: {cursor: string | null; id: string}
        }) => Promise<void> | void
        onSpoolWindowCreated?: (window: {cursor: string | null; id: string}) => Promise<void> | void
      }) => {
        calls.push('reconciliation:fetch')
        const window = {id: 'spool-window-1', cursor: 'cursor-after-page'}
        await input.onSpoolWindowCreated?.(window)
        await input.onPageSpooled?.({cursor: 'cursor-after-page', window})
        return {fetchedTotal: 1, pageCount: 1, reason: 'fetched', status: 'spooled', window}
      },
    } as never,
    trackingRepository: {
      claimDueSource: async () => {
        throw new Error('incremental source claim should not run')
      },
      selectDueSources: async () => {
        return []
      },
    } as never,
  })

  const result = await worker.wake({maxFetchSources: 0, maxReconciliationWork: 1, now})

  expect(result.sourceResults).toEqual([])
  expect(result.reconciliationResults).toEqual([
    {
      dataSourceId: 'source-1',
      pageCount: 1,
      reason: 'fetched',
      status: 'spooled',
      windowId: 'spool-window-1',
      workId: 'work-1',
    },
  ])
  expect(calls).toEqual([
    'reconciliation:schedule',
    'reconciliation:claim',
    'datasource:get',
    'reconciliation:fetch',
    'reconciliation:progress',
    'reconciliation:progress',
    'reconciliation:progress',
    'spool:drain',
  ])
})

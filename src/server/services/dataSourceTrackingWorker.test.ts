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
      hasRetryableFetchFailedWindow: () => {
        return false
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

test('data source tracking worker promotes retryable fetch-failed windows before claiming under aggregate backpressure', async () => {
  const calls: string[] = []
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
        calls.push('spool:drain')
        return [
          {
            acceptedCount: 1,
            importRunId: 'data-source-tracking:window-1',
            pageCount: 10,
            reason: 'ingested',
            recordCount: 10,
            status: 'success',
            windowId: 'window-1',
          },
        ]
      },
    },
    spoolRepository: {
      getBackpressureSignal: () => {
        calls.push('spool:signal')
        return {
          backpressureActive: true,
          backlog: {
            failedWindowCount: 2,
            oldestReadyAt: null,
            pendingPageCount: 20,
            pendingWindowCount: 2,
            readyWindowCount: 0,
          },
        }
      },
      hasRetryableFetchFailedWindow: () => {
        calls.push('spool:has-fetch-failed')
        return true
      },
      promoteRetryableFetchFailedWindowForIngest: () => {
        calls.push('spool:promote-fetch-failed')
        return {id: 'window-1', status: 'ready'}
      },
    } as never,
    reconciliationWorkRepository: {
      claimNextWork: async () => {
        calls.push('reconciliation:claim')
        return null
      },
      scheduleDueMonthlyAgeBucketWork: async () => {
        calls.push('reconciliation:schedule')
        return []
      },
    } as never,
    trackingRepository: {
      claimDueSource: async () => {
        calls.push('source:claim')
        return null
      },
      selectDueSources: async () => {
        return [getState()]
      },
    } as never,
  })

  const result = await worker.wake({now: new Date('2026-09-16T09:00:00.000Z')})

  expect(result.sourceResults).toEqual([{dataSourceId: 'source-1', reason: 'backpressure', status: 'skipped'}])
  expect(result.ingestedWindowCount).toBe(1)
  expect(calls).toContain('spool:promote-fetch-failed')
  expect(calls).not.toContain('source:claim')
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
      renewWorkLease: async () => {
        calls.push('reconciliation:renew')
        return work
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
      recordTrackingFailure: async () => {
        calls.push('tracking:failure')
        return null
      },
      selectDueSources: async () => {
        return []
      },
      startTrackingWindow: async () => {
        calls.push('tracking:start')
        return null
      },
      updateTrackingState: async () => {
        calls.push('tracking:cursor')
        return null
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
    'tracking:start',
    'reconciliation:renew',
    'reconciliation:fetch',
    'reconciliation:renew',
    'reconciliation:progress',
    'tracking:cursor',
    'reconciliation:renew',
    'reconciliation:renew',
    'reconciliation:progress',
    'tracking:cursor',
    'reconciliation:renew',
    'reconciliation:progress',
    'spool:drain',
  ])
})

test('data source tracking worker rechecks backpressure after each spooled page', async () => {
  const calls: string[] = []
  const now = new Date('2026-09-16T09:00:00.000Z')
  const activeState = {
    ...getState(),
    activeRunKind: 'incremental' as const,
    activeWindowEnd: new Date('2026-09-15T00:00:00.000Z'),
    activeWindowStart: new Date('2026-09-15T00:00:00.000Z'),
    leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z'),
    leaseOwner: 'worker',
  }
  let pageSpooled = false
  const backpressureExcludeWindowIds: Array<string | undefined> = []
  const worker = createDataSourceTrackingWorker({
    dataSourceQueryService: {
      getDataSourceById: async (id: string) => {
        calls.push(`datasource:get:${id}`)
        return {
          archived: false,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          cursor: null,
          dateFrom: new Date('2026-09-01T00:00:00.000Z'),
          dateTo: null,
          description: null,
          id,
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
        return {
          getNextWindow: () => {
            return {
              reason: 'next-window',
              status: 'window',
              window: {
                dataSourceId: 'source-1',
                route: pubmedTrackedImportRoute,
                runKind: 'incremental',
                windowEnd: new Date('2026-09-15T00:00:00.000Z'),
                windowStart: new Date('2026-09-15T00:00:00.000Z'),
              },
            }
          },
          route: pubmedTrackedImportRoute,
        }
      },
    } as never,
    reconciliationWorkRepository: {
      claimNextWork: async () => {
        calls.push('reconciliation:claim')
        return null
      },
      scheduleDueMonthlyAgeBucketWork: async () => {
        calls.push('reconciliation:schedule')
        return []
      },
    } as never,
    spoolIngester: {
      drainReadyWindows: async () => {
        calls.push('spool:drain')
        return []
      },
    },
    spoolRepository: {
      getBackpressureSignal: (input?: {excludeWindowId?: string}) => {
        backpressureExcludeWindowIds.push(input?.excludeWindowId)
        const ownerWindowExcluded = input?.excludeWindowId === 'window-1'

        return {
          backpressureActive: pageSpooled && !ownerWindowExcluded,
          backlog: {
            failedWindowCount: 0,
            oldestReadyAt: null,
            pendingPageCount: pageSpooled && !ownerWindowExcluded ? 20 : 0,
            pendingWindowCount: pageSpooled && !ownerWindowExcluded ? 5 : 0,
            readyWindowCount: pageSpooled && !ownerWindowExcluded ? 5 : 0,
          },
        }
      },
      hasRetryableFetchFailedWindow: () => {
        return false
      },
    } as never,
    trackedImportService: {
      fetchWindowToSpool: async (input: {
        onPageSpooled?: (input: {
          cursor: string | null
          window: {cursor: string | null; id: string}
        }) => Promise<void> | void
        assertPageAppendAllowed?: (input: {
          cursor: string | null
          window: {cursor: string | null; id: string}
        }) => Promise<void> | void
      }) => {
        calls.push('source:fetch')
        await input.assertPageAppendAllowed?.({
          cursor: 'cursor-after-page',
          window: {cursor: 'cursor-after-page', id: 'window-1'},
        })
        pageSpooled = true
        await input.onPageSpooled?.({
          cursor: 'cursor-after-page',
          window: {cursor: 'cursor-after-page', id: 'window-1'},
        })
        return {fetchedTotal: 1, pageCount: 1, reason: 'fetched', status: 'spooled', window: {id: 'window-1'}}
      },
    } as never,
    trackingRepository: {
      claimDueSource: async ({dataSourceId}: {dataSourceId: string}) => {
        calls.push(`source:claim:${dataSourceId}`)
        return {...getState(), dataSourceId, leaseOwner: 'worker', leaseExpiresAt: new Date('2026-09-16T09:10:00.000Z')}
      },
      getTrackingState: async () => {
        return activeState
      },
      recordTrackingFailure: async () => {
        calls.push('tracking:failure')
        return null
      },
      releaseSourceLease: async () => {
        calls.push('tracking:release')
        return null
      },
      renewSourceLease: async () => {
        calls.push('tracking:renew')
        return activeState
      },
      selectDueSources: async () => {
        return [getState(), {...getState(), dataSourceId: 'source-2'}]
      },
      startTrackingWindow: async () => {
        calls.push('tracking:start')
        return activeState
      },
      updateTrackingState: async () => {
        calls.push('tracking:cursor')
        return activeState
      },
    } as never,
  })

  const result = await worker.wake({maxFetchSources: 2, now})

  expect(result.backpressureActive).toBe(true)
  expect(backpressureExcludeWindowIds).not.toContain('window-1')
  expect(result.sourceResults).toEqual([
    {dataSourceId: 'source-1', pageCount: 1, reason: 'fetched', status: 'spooled', windowId: 'window-1'},
    {dataSourceId: 'source-2', reason: 'backpressure', status: 'skipped'},
  ])
  expect(calls).toEqual([
    'reconciliation:schedule',
    'source:claim:source-1',
    'datasource:get:source-1',
    'tracking:start',
    'tracking:renew',
    'source:fetch',
    'tracking:renew',
    'tracking:renew',
    'tracking:renew',
    'tracking:cursor',
    'tracking:renew',
    'tracking:release',
    'spool:drain',
  ])
})

test('data source tracking worker aborts page append as soon as source lease renewal fails', async () => {
  const now = new Date('2099-01-01T00:00:00.000Z')
  const activeState = {
    ...getState(),
    activeRunKind: 'incremental' as const,
    activeWindowEnd: new Date('2026-09-15T00:00:00.000Z'),
    activeWindowStart: new Date('2026-09-15T00:00:00.000Z'),
    leaseExpiresAt: new Date('2099-01-01T00:10:00.000Z'),
    leaseOwner: 'worker',
  }
  let renewCount = 0
  let pageAppendAllowedCalled = false
  let onPageSpooledCalled = false
  let recordedFailure: {error: string; nextRunAfterIso: string | null; nowIso: string | null} | null = null
  const worker = createDataSourceTrackingWorker({
    dataSourceQueryService: {
      getDataSourceById: async () => {
        return {
          archived: false,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          cursor: null,
          dateFrom: new Date('2026-09-01T00:00:00.000Z'),
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
        return {
          getNextWindow: () => {
            return {
              reason: 'next-window',
              status: 'window',
              window: {
                dataSourceId: 'source-1',
                route: pubmedTrackedImportRoute,
                runKind: 'incremental',
                windowEnd: new Date('2026-09-15T00:00:00.000Z'),
                windowStart: new Date('2026-09-15T00:00:00.000Z'),
              },
            }
          },
          route: pubmedTrackedImportRoute,
        }
      },
    } as never,
    reconciliationWorkRepository: {
      claimNextWork: async () => {
        return null
      },
      scheduleDueMonthlyAgeBucketWork: async () => {
        return []
      },
    } as never,
    spoolIngester: {
      drainReadyWindows: async () => {
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
      fetchWindowToSpool: async (input: {
        assertPageAppendAllowed?: (input: {
          cursor: string | null
          window: {cursor: string | null; id: string}
        }) => Promise<void> | void
        onPageSpooled?: (input: {
          cursor: string | null
          window: {cursor: string | null; id: string}
        }) => Promise<void> | void
      }) => {
        pageAppendAllowedCalled = true
        await input.assertPageAppendAllowed?.({
          cursor: 'cursor-after-page',
          window: {cursor: 'cursor-after-page', id: 'window-1'},
        })
        onPageSpooledCalled = true
        await input.onPageSpooled?.({
          cursor: 'cursor-after-page',
          window: {cursor: 'cursor-after-page', id: 'window-1'},
        })
        return {fetchedTotal: 1, pageCount: 1, reason: 'fetched', status: 'spooled', window: {id: 'window-1'}}
      },
    } as never,
    trackingRepository: {
      claimDueSource: async ({dataSourceId}: {dataSourceId: string}) => {
        return {...getState(), dataSourceId, leaseExpiresAt: new Date('2099-01-01T00:10:00.000Z'), leaseOwner: 'worker'}
      },
      getTrackingState: async () => {
        return activeState
      },
      recordTrackingFailure: async (input: {error: string; nextRunAfter?: Date | null; now?: Date}) => {
        recordedFailure = {
          error: input.error,
          nextRunAfterIso: input.nextRunAfter?.toISOString() ?? null,
          nowIso: input.now?.toISOString() ?? null,
        }
        return null
      },
      renewSourceLease: async () => {
        renewCount += 1
        return renewCount === 1 ? activeState : null
      },
      selectDueSources: async () => {
        return [getState()]
      },
      startTrackingWindow: async () => {
        return activeState
      },
      updateTrackingState: async () => {
        throw new Error('cursor should not advance after lease loss')
      },
    } as never,
  })

  const result = await worker.wake({maxFetchSources: 1, now})

  expect(pageAppendAllowedCalled).toBe(true)
  expect(onPageSpooledCalled).toBe(false)
  expect(result.sourceResults).toEqual([
    {
      dataSourceId: 'source-1',
      error: 'Data source tracking lease lost',
      reason: 'fetch-failed',
      status: 'failed',
      windowId: '2026-09-15T00:00:00.000Z',
    },
  ])
  const failure = recordedFailure

  if (!failure?.nowIso || !failure.nextRunAfterIso) {
    throw new Error('Expected tracking failure timestamp evidence')
  }

  expect(failure.error).toBe('Data source tracking lease lost')
  expect(failure.nowIso).toBe('2099-01-01T00:00:00.000Z')
  expect(failure.nextRunAfterIso).toBe('2099-01-01T00:05:00.000Z')
})

import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {createDataSourceTrackingSpoolRepository} from './dataSourceTrackingSpoolRepository.ts'

const withSpoolRepository = <T>(
  operation: (repository: ReturnType<typeof createDataSourceTrackingSpoolRepository>) => T,
) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-data-source-tracking-spool-'))
  const repository = createDataSourceTrackingSpoolRepository({sqlitePath: join(root, 'tracking-spool.sqlite')})

  try {
    return operation(repository)
  } finally {
    repository.close()
    rmSync(root, {force: true, recursive: true})
  }
}

test('tracking spool resumes from the atomically appended page cursor', () => {
  withSpoolRepository((repository) => {
    const window = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })

    repository.appendPage({
      cursorAfter: 'cursor-after-page-1',
      cursorBefore: null,
      normalizedRecordsJson: [{id: 'article-1'}],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })

    const resumed = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })

    expect(resumed.id).toBe(window.id)
    expect(repository.getResumeCursor(window.id)).toBe('cursor-after-page-1')
    const pages = repository.getWindowPages(window.id)
    expect(pages).toHaveLength(1)
    expect(pages[0]?.cursorAfter).toBe('cursor-after-page-1')
    expect(pages[0]?.normalizedRecordsJson).toEqual([{id: 'article-1'}])
    expect(pages[0]?.pageIndex).toBe(0)
  })
})

test('tracking spool page append rolls back cursor advancement when the page insert fails', () => {
  withSpoolRepository((repository) => {
    const window = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })

    repository.appendPage({
      cursorAfter: 'cursor-after-page-1',
      cursorBefore: null,
      normalizedRecordsJson: [{id: 'article-1'}],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })

    expect(() => {
      repository.appendPage({
        cursorAfter: 'cursor-after-duplicate',
        cursorBefore: 'cursor-after-page-1',
        normalizedRecordsJson: [{id: 'article-duplicate'}],
        pageIndex: 0,
        rawPayloadJson: {page: 'duplicate'},
        sourceRecordCount: 1,
        sourceRecordHash: 'hash-duplicate',
        windowId: window.id,
      })
    }).toThrow()

    expect(repository.getResumeCursor(window.id)).toBe('cursor-after-page-1')
    expect(repository.getWindowPages(window.id)).toHaveLength(1)
  })
})

test('tracking spool ingest claims are idempotent until lease expiry and cleanup removes ingested pages', () => {
  withSpoolRepository((repository) => {
    const window = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/europe-pmc-ppr',
      runKind: 'automatic_age_bucket',
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    })

    repository.appendPage({
      cursorAfter: null,
      cursorBefore: null,
      normalizedRecordsJson: [{id: 'article-1'}, {id: 'article-2'}],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 2,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })
    repository.markWindowReady({spooledAt: new Date('2026-09-15T09:00:00.000Z'), windowId: window.id})

    const firstClaim = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T09:05:00.000Z'),
      leaseOwner: 'ingest-worker-a',
      limit: 10,
      now: new Date('2026-09-15T09:00:10.000Z'),
    })
    const duplicateClaim = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T09:05:00.000Z'),
      leaseOwner: 'ingest-worker-b',
      limit: 10,
      now: new Date('2026-09-15T09:01:00.000Z'),
    })

    expect(firstClaim).toHaveLength(1)
    expect(firstClaim[0]?.id).toBe(window.id)
    expect(firstClaim[0]?.leaseOwner).toBe('ingest-worker-a')
    expect(firstClaim[0]?.status).toBe('ingesting')
    expect(duplicateClaim).toEqual([])

    repository.markWindowIngested({
      ingestedAt: new Date('2026-09-15T09:02:00.000Z'),
      leaseOwner: 'ingest-worker-a',
      windowId: window.id,
    })
    const cleanup = repository.cleanupIngested({ingestedBefore: new Date('2026-09-15T09:03:00.000Z'), limit: 10})

    expect(cleanup).toEqual({pagesDeleted: 1, windowsDeleted: 1})
    expect(repository.getWindow(window.id)).toBeNull()
    expect(repository.getWindowPages(window.id)).toEqual([])
  })
})

test('tracking spool reports backlog backpressure and preserves failed-window backoff evidence', () => {
  withSpoolRepository((repository) => {
    const firstWindow = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })
    const secondWindow = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-15T00:00:00.000Z'),
      windowStart: new Date('2026-09-14T00:00:00.000Z'),
    })

    for (const [index, window] of [firstWindow, secondWindow].entries()) {
      repository.appendPage({
        cursorAfter: `cursor-${index}`,
        cursorBefore: null,
        normalizedRecordsJson: [{id: `article-${index}`}],
        pageIndex: 0,
        rawPayloadJson: {page: index},
        sourceRecordCount: 1,
        sourceRecordHash: `hash-${index}`,
        windowId: window.id,
      })
      repository.markWindowReady({spooledAt: new Date(`2026-09-15T09:0${index}:00.000Z`), windowId: window.id})
    }

    const signal = repository.getBackpressureSignal({maxPendingPages: 2, maxPendingWindows: 10})
    expect(signal.backpressureActive).toBe(true)
    expect(signal.backlog.pendingPageCount).toBe(2)
    expect(signal.backlog.pendingWindowCount).toBe(2)

    const failed = repository.markWindowFailed({
      error: 'rate limited',
      nextRetryAt: new Date('2026-09-15T10:00:00.000Z'),
      windowId: firstWindow.id,
    })
    const backlogAfterFailure = repository.getBacklog()

    expect(failed?.failureCount).toBe(1)
    expect(failed?.lastError).toBe('rate limited')
    expect(failed?.nextRetryAt?.toISOString()).toBe('2026-09-15T10:00:00.000Z')
    expect(failed?.status).toBe('ingest_failed')
    expect(backlogAfterFailure.failedWindowCount).toBe(1)
    expect(backlogAfterFailure.pendingPageCount).toBe(1)
  })
})

test('tracking spool retry claims ingest-failed windows only after their retry time', () => {
  withSpoolRepository((repository) => {
    const window = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })

    repository.appendPage({
      cursorAfter: null,
      cursorBefore: null,
      normalizedRecordsJson: [{id: 'article-1'}],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })
    repository.markWindowReady({spooledAt: new Date('2026-09-15T08:59:00.000Z'), windowId: window.id})
    repository.markWindowFailed({
      error: 'duckdb unavailable',
      nextRetryAt: new Date('2026-09-15T10:00:00.000Z'),
      now: new Date('2026-09-15T09:00:00.000Z'),
      windowId: window.id,
    })

    const earlyClaim = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T09:10:00.000Z'),
      leaseOwner: 'ingest-worker-a',
      limit: 10,
      now: new Date('2026-09-15T09:05:00.000Z'),
    })
    const retryClaim = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T10:10:00.000Z'),
      leaseOwner: 'ingest-worker-b',
      limit: 10,
      now: new Date('2026-09-15T10:00:00.000Z'),
    })

    expect(earlyClaim).toEqual([])
    expect(retryClaim).toHaveLength(1)
    expect(retryClaim[0]?.id).toBe(window.id)
    expect(retryClaim[0]?.leaseOwner).toBe('ingest-worker-b')
    expect(retryClaim[0]?.status).toBe('ingesting')
  })
})

test('tracking spool never claims fetch-failed windows for DuckDB ingest', () => {
  withSpoolRepository((repository) => {
    const window = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })

    repository.appendPage({
      cursorAfter: 'cursor-after-partial-page',
      cursorBefore: null,
      normalizedRecordsJson: [{id: 'article-1'}],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })
    const failed = repository.markWindowFailed({
      error: 'provider timeout',
      nextRetryAt: new Date('2026-09-15T10:00:00.000Z'),
      now: new Date('2026-09-15T09:00:00.000Z'),
      status: 'fetch_failed',
      windowId: window.id,
    })

    const claim = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T10:10:00.000Z'),
      leaseOwner: 'ingest-worker',
      limit: 10,
      now: new Date('2026-09-15T10:00:00.000Z'),
    })

    expect(failed?.status).toBe('fetch_failed')
    expect(repository.getResumeCursor(window.id)).toBe('cursor-after-partial-page')
    expect(claim).toEqual([])
  })
})

test('tracking spool renews owned ingest leases and never reclaims rejected windows', () => {
  withSpoolRepository((repository) => {
    const window = repository.createOrResumeWindow({
      dataSourceId: 'source-1',
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      windowEnd: new Date('2026-09-14T00:00:00.000Z'),
      windowStart: new Date('2026-09-13T00:00:00.000Z'),
    })

    repository.appendPage({
      cursorAfter: null,
      cursorBefore: null,
      normalizedRecordsJson: [{id: 'article-1'}],
      pageIndex: 0,
      rawPayloadJson: {page: 1},
      sourceRecordCount: 1,
      sourceRecordHash: 'hash-page-1',
      windowId: window.id,
    })
    repository.markWindowReady({spooledAt: new Date('2026-09-15T09:00:00.000Z'), windowId: window.id})

    const [claim] = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T09:05:00.000Z'),
      leaseOwner: 'ingest-worker-a',
      limit: 1,
      now: new Date('2026-09-15T09:00:00.000Z'),
    })
    const wrongOwnerRenewal = repository.renewWindowLease({
      leaseExpiresAt: new Date('2026-09-15T09:10:00.000Z'),
      leaseOwner: 'ingest-worker-b',
      now: new Date('2026-09-15T09:01:00.000Z'),
      windowId: window.id,
    })
    const renewed = repository.renewWindowLease({
      leaseExpiresAt: new Date('2026-09-15T09:10:00.000Z'),
      leaseOwner: 'ingest-worker-a',
      now: new Date('2026-09-15T09:01:00.000Z'),
      windowId: window.id,
    })
    const rejected = repository.markWindowRejected({
      error: 'route changed',
      now: new Date('2026-09-15T09:02:00.000Z'),
      windowId: window.id,
    })
    const retryClaim = repository.claimReadyWindowsForIngest({
      leaseExpiresAt: new Date('2026-09-15T10:05:00.000Z'),
      leaseOwner: 'ingest-worker-c',
      limit: 1,
      now: new Date('2026-09-15T10:00:00.000Z'),
    })

    expect(claim?.leaseOwner).toBe('ingest-worker-a')
    expect(wrongOwnerRenewal).toBeNull()
    expect(renewed?.leaseExpiresAt?.toISOString()).toBe('2026-09-15T09:10:00.000Z')
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.lastError).toBe('route changed')
    expect(retryClaim).toEqual([])
  })
})

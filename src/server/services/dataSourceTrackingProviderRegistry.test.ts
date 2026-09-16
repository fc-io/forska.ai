import {expect, test} from 'bun:test'

import type {DataSourceRecord, DataSourceTrackingStateRecord} from '../../db/schemaTypes.ts'
import {
  createDataSourceTrackingProviderRegistry,
  getLatestFullyClosedUtcDay,
  pubmedTrackedImportRoute,
} from './dataSourceTrackingProviderRegistry.ts'

const baseDate = new Date('2026-09-16T12:00:00.000Z')

const getDataSource = (overrides: Partial<DataSourceRecord> = {}): DataSourceRecord => {
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
    ...overrides,
  }
}

const getState = (overrides: Partial<DataSourceTrackingStateRecord> = {}): DataSourceTrackingStateRecord => {
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
    ...overrides,
  }
}

const getPubmedProvider = () => {
  const provider = createDataSourceTrackingProviderRegistry().getProvider(pubmedTrackedImportRoute)

  if (!provider) {
    throw new Error('PubMed tracking provider missing')
  }

  return provider
}

test('day tracking provider selects open-ended windows through the latest fully closed UTC day', () => {
  const provider = getPubmedProvider()
  const selection = provider.getNextWindow({
    dataSource: getDataSource(),
    now: baseDate,
    state: getState({highWaterCompletedAt: new Date('2026-09-14T00:00:00.000Z')}),
  })

  expect(getLatestFullyClosedUtcDay(baseDate).toISOString()).toBe('2026-09-15T00:00:00.000Z')
  expect(selection.status).toBe('window')
  expect(selection.status === 'window' ? selection.window.windowStart.toISOString() : null).toBe(
    '2026-09-15T00:00:00.000Z',
  )
  expect(selection.status === 'window' ? selection.window.windowEnd.toISOString() : null).toBe(
    '2026-09-15T00:00:00.000Z',
  )
})

test('day tracking provider caps future date_to at the latest fully closed UTC day', () => {
  const provider = getPubmedProvider()
  const selection = provider.getNextWindow({
    dataSource: getDataSource({dateTo: new Date('2026-09-30T00:00:00.000Z')}),
    now: baseDate,
    state: getState({highWaterCompletedAt: new Date('2026-09-14T00:00:00.000Z')}),
  })

  expect(selection.status).toBe('window')
  expect(selection.status === 'window' ? selection.window.windowStart.toISOString() : null).toBe(
    '2026-09-15T00:00:00.000Z',
  )
})

test('day tracking provider does not continue before a moved-forward date_from boundary', () => {
  const provider = getPubmedProvider()
  const selection = provider.getNextWindow({
    dataSource: getDataSource({dateFrom: new Date('2026-09-14T00:00:00.000Z')}),
    now: baseDate,
    state: getState({highWaterCompletedAt: new Date('2026-09-10T00:00:00.000Z')}),
  })

  expect(selection.status).toBe('window')
  expect(selection.status === 'window' ? selection.window.windowStart.toISOString() : null).toBe(
    '2026-09-14T00:00:00.000Z',
  )
})

test('day tracking provider completes finite past ranges once high water reaches date_to', () => {
  const provider = getPubmedProvider()
  const selection = provider.getNextWindow({
    dataSource: getDataSource({dateTo: new Date('2026-09-14T00:00:00.000Z')}),
    now: baseDate,
    state: getState({highWaterCompletedAt: new Date('2026-09-14T00:00:00.000Z')}),
  })

  expect(selection).toMatchObject({reason: 'complete', status: 'none'})
})

test('day tracking provider resumes active windows before selecting a new one', () => {
  const provider = getPubmedProvider()
  const selection = provider.getNextWindow({
    dataSource: getDataSource({dateFrom: null}),
    now: baseDate,
    state: getState({
      activeRunKind: 'incremental',
      activeWindowEnd: new Date('2026-09-13T00:00:00.000Z'),
      activeWindowStart: new Date('2026-09-12T00:00:00.000Z'),
    }),
  })

  expect(selection.status).toBe('window')
  expect(selection.status === 'window' ? selection.reason : null).toBe('active-window')
  expect(selection.status === 'window' ? selection.window.windowStart.toISOString() : null).toBe(
    '2026-09-12T00:00:00.000Z',
  )
})

test('day tracking provider requires date_from for non-active tracked sources', () => {
  const provider = getPubmedProvider()
  const selection = provider.getNextWindow({
    dataSource: getDataSource({dateFrom: null}),
    now: baseDate,
    state: getState(),
  })

  expect(selection).toMatchObject({reason: 'missing-date-from', status: 'none'})
})

test('day tracking provider selects monthly reconciliation ranges as exclusive UTC periods', () => {
  const provider = getPubmedProvider()
  const selection = provider.getReconciliationRange({
    ageMonths: 3,
    dataSource: getDataSource({dateFrom: new Date('2025-01-15T00:00:00.000Z')}),
    mode: 'automaticAgeBucket',
    now: baseDate,
  })

  expect(selection.status).toBe('range')
  expect(selection.status === 'range' ? selection.range.periodStart.toISOString() : null).toBe(
    '2026-06-01T00:00:00.000Z',
  )
  expect(selection.status === 'range' ? selection.range.periodEnd.toISOString() : null).toBe('2026-07-01T00:00:00.000Z')
  expect(selection.status === 'range' ? selection.range.runKind : null).toBe('automatic_age_bucket')
})

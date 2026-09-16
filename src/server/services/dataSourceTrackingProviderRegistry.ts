import {fetchEuropePmcPprHarvestPages} from '../../agent/europePmcPprHarvest.ts'
import {fetchPubmedHarvestPages} from '../../agent/pubmedHarvest.ts'
import type {
  DataSourceReconciliationRunKind,
  DataSourceRecord,
  DataSourceTrackingGranularity,
  DataSourceTrackingStateRecord,
} from '../../db/schemaTypes.ts'
import type {ArticleImportStoreRow} from './articleImportStoreService.ts'

export const pubmedTrackedImportRoute = '/api/datasources/import/pubmed'
export const europePmcPprTrackedImportRoute = '/api/datasources/import/europe-pmc-ppr'
export const supportedTrackedImportRoutes = [pubmedTrackedImportRoute, europePmcPprTrackedImportRoute] as const

export type SupportedDataSourceTrackedImportRoute = (typeof supportedTrackedImportRoutes)[number]

export type DataSourceTrackingWindow = {
  dataSourceId: string
  route: SupportedDataSourceTrackedImportRoute
  runKind: 'incremental'
  windowEnd: Date
  windowStart: Date
}

export type DataSourceReconciliationRange = {
  ageMonths: number | null
  dataSourceId: string
  periodEnd: Date
  periodStart: Date
  route: SupportedDataSourceTrackedImportRoute
  runKind: DataSourceReconciliationRunKind
}

export type DataSourceTrackingWindowSelection =
  | {reason: 'active-window'; window: DataSourceTrackingWindow; status: 'window'}
  | {reason: 'next-window'; window: DataSourceTrackingWindow; status: 'window'}
  | {nextRunAfter: Date | null; reason: 'complete' | 'missing-date-from' | 'waiting-for-closed-day'; status: 'none'}

export type DataSourceReconciliationRangeSelection =
  | {range: DataSourceReconciliationRange; reason: 'automatic-age-bucket' | 'manual-full-range'; status: 'range'}
  | {reason: 'empty-range' | 'missing-date-from' | 'unsupported-route'; status: 'none'}

export type DataSourceTrackingFetchPage = {
  cursorAfter: string | null
  cursorBefore: string | null
  normalizedRecords: ArticleImportStoreRow[]
  pageIndex: number
  rawPage: unknown
  sourceRecordCount: number
  sourceRecordHash: string
}

export type FetchDataSourceTrackingWindowPages = (input: {
  cursor?: string | null
  fromDate: string
  importRoute: string
  onPage: (page: DataSourceTrackingFetchPage) => Promise<void> | void
  toDate: string
}) => Promise<{fetchedTotal: number; pageCount: number}>

export type DataSourceTrackingProvider = {
  fetchRangePages: FetchDataSourceTrackingWindowPages
  fetchWindowPages: FetchDataSourceTrackingWindowPages
  getGranularity: () => DataSourceTrackingGranularity
  getNextRunAfter: (input: {
    dataSource: DataSourceRecord
    completedWindow: DataSourceTrackingWindow
    now: Date
  }) => Date | null
  getNextWindow: (input: {
    dataSource: DataSourceRecord
    now: Date
    state: DataSourceTrackingStateRecord | null
  }) => DataSourceTrackingWindowSelection
  getReconciliationRange: (input: {
    ageMonths: number | null
    dataSource: DataSourceRecord
    mode: 'automaticAgeBucket' | 'manualFullRange'
    now: Date
    periodEnd?: Date
    periodStart?: Date
  }) => DataSourceReconciliationRangeSelection
  route: SupportedDataSourceTrackedImportRoute
}

export type DataSourceTrackingProviderRegistry = {
  getProvider: (route: string | null | undefined) => DataSourceTrackingProvider | null
  isSupportedRoute: (route: string | null | undefined) => route is SupportedDataSourceTrackedImportRoute
  listProviders: () => DataSourceTrackingProvider[]
}

const millisecondsPerDay = 24 * 60 * 60 * 1000

const getUtcDayStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

const addUtcDays = (date: Date, days: number) => {
  return new Date(getUtcDayStart(date).getTime() + days * millisecondsPerDay)
}

const compareDates = (left: Date, right: Date) => {
  return left.getTime() - right.getTime()
}

const minDate = (left: Date, right: Date) => {
  return compareDates(left, right) <= 0 ? left : right
}

const maxDate = (left: Date, right: Date) => {
  return compareDates(left, right) >= 0 ? left : right
}

const getUtcMonthStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

const addUtcMonths = (date: Date, months: number) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}

export const getLatestFullyClosedUtcDay = (now: Date) => {
  return addUtcDays(now, -1)
}

export const formatUtcDay = (date: Date) => {
  return getUtcDayStart(date).toISOString().slice(0, 10)
}

const isUsableDate = (date: Date | null | undefined): date is Date => {
  return date instanceof Date && !Number.isNaN(date.getTime())
}

const getSupportedRoute = (route: string | null | undefined): SupportedDataSourceTrackedImportRoute | null => {
  return (
    supportedTrackedImportRoutes.find((supportedRoute) => {
      return supportedRoute === route
    }) ?? null
  )
}

const createDayTrackingProvider = (
  route: SupportedDataSourceTrackedImportRoute,
  fetchWindowPages: FetchDataSourceTrackingWindowPages,
): DataSourceTrackingProvider => {
  const getNextWindow: DataSourceTrackingProvider['getNextWindow'] = ({dataSource, now, state}) => {
    const supportedRoute = getSupportedRoute(state?.route ?? dataSource.importRoute ?? route)

    if (!supportedRoute) {
      return {nextRunAfter: null, reason: 'complete', status: 'none'}
    }

    if (
      state?.activeRunKind === 'incremental'
      && isUsableDate(state.activeWindowStart)
      && isUsableDate(state.activeWindowEnd)
    ) {
      return {
        reason: 'active-window',
        status: 'window',
        window: {
          dataSourceId: dataSource.id,
          route: supportedRoute,
          runKind: 'incremental',
          windowEnd: getUtcDayStart(state.activeWindowEnd),
          windowStart: getUtcDayStart(state.activeWindowStart),
        },
      }
    }

    if (!isUsableDate(dataSource.dateFrom)) {
      return {nextRunAfter: addUtcDays(now, 1), reason: 'missing-date-from', status: 'none'}
    }

    const startBoundary = getUtcDayStart(dataSource.dateFrom)
    const latestClosedDay = getLatestFullyClosedUtcDay(now)
    const configuredEndBoundary = isUsableDate(dataSource.dateTo) ? getUtcDayStart(dataSource.dateTo) : null
    const cappedEndBoundary = configuredEndBoundary ? minDate(configuredEndBoundary, latestClosedDay) : latestClosedDay
    const completedBoundary = isUsableDate(state?.highWaterCompletedAt)
      ? getUtcDayStart(state.highWaterCompletedAt)
      : null

    if (configuredEndBoundary && completedBoundary && compareDates(completedBoundary, configuredEndBoundary) >= 0) {
      return {nextRunAfter: null, reason: 'complete', status: 'none'}
    }

    const nextStart = completedBoundary ? maxDate(addUtcDays(completedBoundary, 1), startBoundary) : startBoundary

    if (compareDates(nextStart, cappedEndBoundary) > 0) {
      return {
        nextRunAfter: addUtcDays(latestClosedDay, 2),
        reason: configuredEndBoundary ? 'complete' : 'waiting-for-closed-day',
        status: 'none',
      }
    }

    return {
      reason: 'next-window',
      status: 'window',
      window: {
        dataSourceId: dataSource.id,
        route: supportedRoute,
        runKind: 'incremental',
        windowEnd: nextStart,
        windowStart: nextStart,
      },
    }
  }

  const getReconciliationRange: DataSourceTrackingProvider['getReconciliationRange'] = ({
    ageMonths,
    dataSource,
    mode,
    now,
    periodEnd,
    periodStart,
  }) => {
    const supportedRoute = getSupportedRoute(dataSource.importRoute ?? route)

    if (!supportedRoute) {
      return {reason: 'unsupported-route', status: 'none'}
    }

    if (!isUsableDate(dataSource.dateFrom)) {
      return {reason: 'missing-date-from', status: 'none'}
    }

    const configuredStart = getUtcDayStart(dataSource.dateFrom)
    const latestClosedEnd = getUtcDayStart(now)
    const configuredEnd = isUsableDate(dataSource.dateTo) ? addUtcDays(dataSource.dateTo, 1) : latestClosedEnd
    const endBoundary = minDate(configuredEnd, latestClosedEnd)
    const baseRange =
      mode === 'manualFullRange'
        ? {
            periodEnd: periodEnd ? getUtcDayStart(periodEnd) : endBoundary,
            periodStart: periodStart ? getUtcDayStart(periodStart) : configuredStart,
          }
        : {
            periodEnd: periodEnd
              ? getUtcDayStart(periodEnd)
              : addUtcMonths(addUtcMonths(getUtcMonthStart(now), -(ageMonths ?? 0)), 1),
            periodStart: periodStart
              ? getUtcDayStart(periodStart)
              : addUtcMonths(getUtcMonthStart(now), -(ageMonths ?? 0)),
          }
    const rangeStart = maxDate(baseRange.periodStart, configuredStart)
    const rangeEnd = minDate(baseRange.periodEnd, endBoundary)

    if (compareDates(rangeEnd, rangeStart) <= 0) {
      return {reason: 'empty-range', status: 'none'}
    }

    return {
      range: {
        ageMonths,
        dataSourceId: dataSource.id,
        periodEnd: rangeEnd,
        periodStart: rangeStart,
        route: supportedRoute,
        runKind: mode === 'automaticAgeBucket' ? 'automatic_age_bucket' : 'manual_full_range',
      },
      reason: mode === 'automaticAgeBucket' ? 'automatic-age-bucket' : 'manual-full-range',
      status: 'range',
    }
  }

  return {
    fetchRangePages: fetchWindowPages,
    fetchWindowPages,
    getGranularity: () => {
      return 'day'
    },
    getNextRunAfter: ({dataSource, completedWindow, now}) => {
      const latestClosedDay = getLatestFullyClosedUtcDay(now)
      const completedDay = getUtcDayStart(completedWindow.windowEnd)

      if (isUsableDate(dataSource.dateTo) && compareDates(completedDay, getUtcDayStart(dataSource.dateTo)) >= 0) {
        return null
      }

      return compareDates(completedDay, latestClosedDay) < 0 ? now : addUtcDays(completedDay, 2)
    },
    getReconciliationRange,
    getNextWindow,
    route,
  }
}

export const createDataSourceTrackingProviderRegistry = (
  providers: DataSourceTrackingProvider[] = [
    createDayTrackingProvider(pubmedTrackedImportRoute, fetchPubmedHarvestPages),
    createDayTrackingProvider(europePmcPprTrackedImportRoute, fetchEuropePmcPprHarvestPages),
  ],
): DataSourceTrackingProviderRegistry => {
  const providersByRoute = new Map(
    providers.map((provider) => {
      return [provider.route, provider]
    }),
  )

  return {
    getProvider: (route) => {
      const supportedRoute = getSupportedRoute(route)

      return supportedRoute ? (providersByRoute.get(supportedRoute) ?? null) : null
    },
    isSupportedRoute: (route): route is SupportedDataSourceTrackedImportRoute => {
      return getSupportedRoute(route) !== null
    },
    listProviders: () => {
      return [...providersByRoute.values()]
    },
  }
}

let cachedDataSourceTrackingProviderRegistry: DataSourceTrackingProviderRegistry | null = null

export const getDataSourceTrackingProviderRegistry = () => {
  cachedDataSourceTrackingProviderRegistry ??= createDataSourceTrackingProviderRegistry()

  return cachedDataSourceTrackingProviderRegistry
}

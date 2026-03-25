export type TokenTimelineInterval = '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'

export type TokenTimelinePoint = {
  timestamp: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalRequests: number
  totalSuccessPromptTokens: number
  totalSuccessCompletionTokens: number
  totalSuccessTokens: number
  totalFailedTokens: number
  count: number
}

type TokenTimelineRow = {
  createdAt: Date
  totalPromptTokens?: number | string | null
  totalCompletionTokens?: number | string | null
  totalTokens?: number | string | null
  requests?: number | string | null
  totalSuccessPromptTokens?: number | string | null
  totalSuccessCompletionTokens?: number | string | null
  totalSuccessTokens?: number | string | null
  totalFailedTokens?: number | string | null
}

export type UsageBucket = {timestamp: string; totalTokens: number}

const intervalMsMap: Record<Exclude<TokenTimelineInterval, '1m'>, number> = {
  '1min': 60 * 1000,
  '5min': 5 * 60 * 1000,
  '15min': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
}

export const getIntervalMs = (interval: Exclude<TokenTimelineInterval, '1m'>): number => {
  return intervalMsMap[interval]
}

export const getHighestUsagePeriod = (interval: TokenTimelineInterval) => {
  const now = Date.now()
  const durationByInterval: Record<TokenTimelineInterval, number> = {
    '1min': 30 * 24 * 60 * 60 * 1000,
    '5min': 30 * 24 * 60 * 60 * 1000,
    '15min': 30 * 24 * 60 * 60 * 1000,
    '1h': 30 * 24 * 60 * 60 * 1000,
    '24h': 30 * 24 * 60 * 60 * 1000,
    '1w': 30 * 7 * 24 * 60 * 60 * 1000,
    '1m': 730 * 24 * 60 * 60 * 1000,
  }

  return new Date(now - durationByInterval[interval])
}

const getUtcMonthStart = (value: Date) => {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0))
}

const getBucketStart = (value: Date, interval: TokenTimelineInterval, anchor: Date) => {
  if (interval === '1m') {
    return getUtcMonthStart(value)
  }

  const intervalMs = getIntervalMs(interval)
  const offset = Math.floor((value.getTime() - anchor.getTime()) / intervalMs)
  return new Date(anchor.getTime() + offset * intervalMs)
}

const getBucketKey = (value: Date, interval: TokenTimelineInterval) => {
  return interval === '1m'
    ? `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`
    : String(value.getTime())
}

const getBucketStarts = (interval: TokenTimelineInterval, start: Date, end: Date) => {
  if (interval === '1m') {
    const starts: Date[] = []
    const cursor = getUtcMonthStart(start)
    const endMonth = getUtcMonthStart(end)

    while (cursor <= endMonth) {
      starts.push(new Date(cursor))
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }

    return starts
  }

  const intervalMs = getIntervalMs(interval)
  const starts: Date[] = []

  for (let time = start.getTime(); time < end.getTime(); time += intervalMs) {
    starts.push(new Date(time))
  }

  return starts
}

const getEmptyPoint = (timestamp: string): TokenTimelinePoint => {
  return {
    timestamp,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalRequests: 0,
    totalSuccessPromptTokens: 0,
    totalSuccessCompletionTokens: 0,
    totalSuccessTokens: 0,
    totalFailedTokens: 0,
    count: 0,
  }
}

export const aggregateTokenTimelineRows = (params: {
  rows: TokenTimelineRow[]
  interval: TokenTimelineInterval
  startDate: string
  endDate: string
}) => {
  const start = new Date(params.startDate)
  const end = new Date(params.endDate)
  const bucketMap = params.rows.reduce<Map<string, TokenTimelinePoint>>((map, row) => {
    const createdAtMs = row.createdAt.getTime()

    if (createdAtMs < start.getTime() || createdAtMs >= end.getTime()) {
      return map
    }

    const bucketStart = getBucketStart(row.createdAt, params.interval, start)
    const bucketKey = getBucketKey(bucketStart, params.interval)
    const current = map.get(bucketKey) ?? getEmptyPoint(bucketStart.toISOString())

    map.set(bucketKey, {
      timestamp: current.timestamp,
      totalPromptTokens: current.totalPromptTokens + Number(row.totalPromptTokens ?? 0),
      totalCompletionTokens: current.totalCompletionTokens + Number(row.totalCompletionTokens ?? 0),
      totalTokens: current.totalTokens + Number(row.totalTokens ?? 0),
      totalRequests: current.totalRequests + Number(row.requests ?? 0),
      totalSuccessPromptTokens: current.totalSuccessPromptTokens + Number(row.totalSuccessPromptTokens ?? 0),
      totalSuccessCompletionTokens:
        current.totalSuccessCompletionTokens + Number(row.totalSuccessCompletionTokens ?? 0),
      totalSuccessTokens: current.totalSuccessTokens + Number(row.totalSuccessTokens ?? 0),
      totalFailedTokens: current.totalFailedTokens + Number(row.totalFailedTokens ?? 0),
      count: current.count + 1,
    })

    return map
  }, new Map<string, TokenTimelinePoint>())

  const completeData = getBucketStarts(params.interval, start, end).map((bucketStart) => {
    const bucketKey = getBucketKey(bucketStart, params.interval)
    return bucketMap.get(bucketKey) ?? getEmptyPoint(bucketStart.toISOString())
  })

  const usedData = Array.from(bucketMap.values()).sort((left, right) => {
    return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
  })

  return {completeData, usedData}
}

export const calculateUsageStats = (buckets: UsageBucket[]) => {
  if (buckets.length === 0) {
    return {highestUsage: null, p90Usage: null}
  }

  const sortedBuckets = [...buckets].sort((left, right) => {
    return left.totalTokens - right.totalTokens
  })
  const percentileIndex = Math.min(sortedBuckets.length - 1, Math.max(0, Math.ceil(sortedBuckets.length * 0.9) - 1))

  return {
    highestUsage: sortedBuckets[sortedBuckets.length - 1] ?? null,
    p90Usage: sortedBuckets[percentileIndex] ?? null,
  }
}

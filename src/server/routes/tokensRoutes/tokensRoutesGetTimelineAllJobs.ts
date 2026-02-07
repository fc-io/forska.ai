import {and, desc, gte, isNotNull, lt, sql, sum} from 'drizzle-orm'

import {tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type TimelineParams = {
  interval: '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'
  startDate: string
  endDate: string
}

const getIntervalSeconds = (interval: Exclude<TimelineParams['interval'], '1m'>): number => {
  const intervals = {
    '1min': 60,
    '5min': 5 * 60,
    '15min': 15 * 60,
    '1h': 60 * 60,
    '24h': 24 * 60 * 60,
    '1w': 7 * 24 * 60 * 60,
  }
  return intervals[interval]
}

export const tokensRoutesGetTimelineAllJobs = async ({interval, startDate, endDate}: TimelineParams) => {
  const db = getDatabase()

  const isMonthly = interval === '1m'
  const intervalSeconds = isMonthly ? undefined : getIntervalSeconds(interval)

  const timeBucket = isMonthly
    ? sql`date_trunc('month', ${tokenUse.createdAt})`
    : sql`date_bin(
    ${sql.raw(`interval '${intervalSeconds} seconds'`)},
    ${tokenUse.createdAt},
    ${sql.raw(`timestamptz '${startDate}'`)}
  )`

  const result = await db
    .select({
      timeBucket: timeBucket,
      totalPromptTokens: sum(tokenUse.totalPromptTokens),
      totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
      totalTokens: sum(tokenUse.totalTokens),
      totalRequests: sum(tokenUse.requests),
      totalSuccessPromptTokens: sum(tokenUse.totalSuccessPromptTokens),
      totalSuccessCompletionTokens: sum(tokenUse.totalSuccessCompletionTokens),
      totalSuccessTokens: sum(tokenUse.totalSuccessTokens),
      totalFailedTokens: sum(tokenUse.totalFailedTokens),
      count: sql<number>`count(*)::int`,
    })
    .from(tokenUse)
    .where(
      and(
        isNotNull(tokenUse.judgmentsJobId),
        gte(tokenUse.createdAt, new Date(startDate)),
        lt(tokenUse.createdAt, new Date(endDate)),
      ),
    )
    .groupBy(timeBucket)
    .orderBy(desc(timeBucket))

  const startTime = new Date(startDate)
  const endTime = new Date(endDate)

  const allBuckets: Date[] = []
  if (isMonthly) {
    const startMonth = new Date(startTime.getFullYear(), startTime.getMonth(), 1, 0, 0, 0, 0)
    const endMonth = new Date(endTime.getFullYear(), endTime.getMonth(), 1, 0, 0, 0, 0)

    for (let d = new Date(startMonth); d <= endMonth; d.setMonth(d.getMonth() + 1)) {
      allBuckets.push(new Date(d))
    }
  } else {
    const intervalMs = (intervalSeconds as number) * 1000
    for (let t = startTime.getTime(); t < endTime.getTime(); t += intervalMs) {
      allBuckets.push(new Date(t))
    }
  }

  const monthKey = (d: Date) => {
    const y = d.getFullYear()
    const m = (d.getMonth() + 1).toString().padStart(2, '0')
    return `${y}-${m}`
  }

  const toKey = (d: Date) => {
    return isMonthly ? monthKey(d) : d.getTime().toString()
  }

  const dataMap = new Map<
    string,
    {
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
  >(
    result.map((row) => {
      const d = new Date(row.timeBucket as string)
      const key = toKey(d)
      return [
        key,
        {
          timestamp: row.timeBucket as string,
          totalPromptTokens: Number(row.totalPromptTokens || 0),
          totalCompletionTokens: Number(row.totalCompletionTokens || 0),
          totalTokens: Number(row.totalTokens || 0),
          totalRequests: Number(row.totalRequests || 0),
          totalSuccessPromptTokens: Number(row.totalSuccessPromptTokens || 0),
          totalSuccessCompletionTokens: Number(row.totalSuccessCompletionTokens || 0),
          totalSuccessTokens: Number(row.totalSuccessTokens || 0),
          totalFailedTokens: Number(row.totalFailedTokens || 0),
          count: row.count,
        },
      ]
    }),
  )

  const completeData = allBuckets.map((bucket) => {
    const key = toKey(bucket)
    const existing = dataMap.get(key)
    return (
      existing || {
        timestamp: bucket.toISOString(),
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
    )
  })

  return {success: true, data: completeData}
}

import {and, eq, gte, lt, sql, sum} from 'drizzle-orm'

import {judgmentsJobs, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type TimelineStatsParams = {projectId: string; interval: '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'}

type UsageBucket = {timestamp: string; totalTokens: number}

type TimelineStats = {highestUsage: UsageBucket | null; p90Usage: UsageBucket | null}

type TimelineStatsCacheValue = TimelineStats & {expiresAt: number}

const timelineStatsTTLms = 5 * 60 * 1000
const timelineStatsCache = new Map<string, TimelineStatsCacheValue>()

const getIntervalSeconds = (interval: Exclude<TimelineStatsParams['interval'], '1m'>): number => {
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

const getHighestUsagePeriod = (interval: TimelineStatsParams['interval']) => {
  const now = new Date()
  const periods = {
    '1min': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    '5min': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    '15min': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    '1h': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    '24h': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    '1w': new Date(now.getTime() - 30 * 7 * 24 * 60 * 60 * 1000),
    '1m': new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000),
  }
  return periods[interval]
}

const calculateUsageStats = (buckets: UsageBucket[]): TimelineStats => {
  if (buckets.length === 0) {
    return {highestUsage: null, p90Usage: null}
  }

  const sortedBuckets = [...buckets].sort((a, b) => {
    return a.totalTokens - b.totalTokens
  })
  const percentileIndex = Math.min(sortedBuckets.length - 1, Math.max(0, Math.ceil(sortedBuckets.length * 0.9) - 1))

  return {
    highestUsage: sortedBuckets[sortedBuckets.length - 1] ?? null,
    p90Usage: sortedBuckets[percentileIndex] ?? null,
  }
}

const getStatsCacheKey = (projectId: string, interval: TimelineStatsParams['interval']) => {
  return `${projectId}|${interval}`
}

export const tokensRoutesGetTimelineStats = async ({projectId, interval}: TimelineStatsParams) => {
  const now = Date.now()
  const cacheKey = getStatsCacheKey(projectId, interval)
  const cached = timelineStatsCache.get(cacheKey)

  if (cached && cached.expiresAt > now) {
    return {success: true, highestUsage: cached.highestUsage, p90Usage: cached.p90Usage}
  }

  const db = getDatabase()
  const projectJobs = await db
    .select({id: judgmentsJobs.id})
    .from(judgmentsJobs)
    .where(eq(judgmentsJobs.projectId, projectId))
  const jobIds = projectJobs.map((job) => {
    return job.id
  })

  if (jobIds.length === 0) {
    return {success: true, highestUsage: null, p90Usage: null}
  }

  const intervalSeconds = interval === '1m' ? null : getIntervalSeconds(interval)
  const bucketOrigin = new Date(0)
  const timeBucket =
    interval === '1m'
      ? sql`date_trunc('month', ${tokenUse.createdAt})`
      : sql`date_bin(make_interval(secs => ${intervalSeconds}), ${tokenUse.createdAt}, ${bucketOrigin})`

  const totalTokensSum = sum(tokenUse.totalTokens).as('totalTokens')
  const usageDistribution = await db
    .select({timeBucket: timeBucket, totalTokens: totalTokensSum})
    .from(tokenUse)
    .where(
      and(
        sql`${tokenUse.judgmentsJobId} = ANY(ARRAY[${sql.join(jobIds, sql`, `)}]::uuid[])`,
        gte(tokenUse.createdAt, getHighestUsagePeriod(interval)),
        lt(tokenUse.createdAt, new Date()),
      ),
    )
    .groupBy(timeBucket)

  const usageStatsInput = usageDistribution.map((row) => {
    return {timestamp: row.timeBucket as string, totalTokens: Number(row.totalTokens ?? 0)}
  })
  const {highestUsage, p90Usage} = calculateUsageStats(usageStatsInput)

  timelineStatsCache.set(cacheKey, {highestUsage, p90Usage, expiresAt: now + timelineStatsTTLms})

  return {success: true, highestUsage, p90Usage}
}

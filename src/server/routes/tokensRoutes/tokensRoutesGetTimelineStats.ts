import {and, eq, gte, inArray, lt} from 'drizzle-orm'

import {judgmentsJobs, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {
  aggregateTokenTimelineRows,
  calculateUsageStats,
  getHighestUsagePeriod,
  type TokenTimelineInterval,
  type UsageBucket,
} from './tokensRoutesTimelineUtils.ts'

type TimelineStatsParams = {projectId: string; interval: TokenTimelineInterval}

type TimelineStats = {highestUsage: UsageBucket | null; p90Usage: UsageBucket | null}

type TimelineStatsCacheValue = TimelineStats & {expiresAt: number}

const timelineStatsTTLms = 5 * 60 * 1000
const timelineStatsCache = new Map<string, TimelineStatsCacheValue>()

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

  const startDate = getHighestUsagePeriod(interval)
  const endDate = new Date()
  const usageRows = await db
    .select({createdAt: tokenUse.createdAt, totalTokens: tokenUse.totalTokens})
    .from(tokenUse)
    .where(
      and(
        inArray(tokenUse.judgmentsJobId, jobIds),
        gte(tokenUse.createdAt, startDate),
        lt(tokenUse.createdAt, endDate),
      ),
    )
  const {usedData} = aggregateTokenTimelineRows({
    rows: usageRows,
    interval,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  })
  const usageStatsInput = usedData.map((row) => {
    return {timestamp: row.timestamp, totalTokens: row.totalTokens}
  })
  const {highestUsage, p90Usage} = calculateUsageStats(usageStatsInput)

  timelineStatsCache.set(cacheKey, {highestUsage, p90Usage, expiresAt: now + timelineStatsTTLms})

  return {success: true, highestUsage, p90Usage}
}

import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'
import {
  aggregateTokenTimelineRows,
  calculateUsageStats,
  getHighestUsagePeriod,
  type TokenTimelineInterval,
  type UsageBucket,
} from './tokensRoutesTimelineUtils.ts'

type TimelineAllJobsStatsParams = {interval: TokenTimelineInterval}

type TimelineStats = {highestUsage: UsageBucket | null; p90Usage: UsageBucket | null}

type TimelineStatsCacheValue = TimelineStats & {expiresAt: number}

const timelineAllJobsStatsTTLms = 5 * 60 * 1000
const timelineAllJobsStatsCache = new Map<string, TimelineStatsCacheValue>()

const getStatsCacheKey = (interval: TimelineAllJobsStatsParams['interval']) => {
  return `all-jobs|${interval}`
}

export const tokensRoutesGetTimelineAllJobsStats = async ({interval}: TimelineAllJobsStatsParams) => {
  const now = Date.now()
  const cacheKey = getStatsCacheKey(interval)
  const cached = timelineAllJobsStatsCache.get(cacheKey)

  if (cached && cached.expiresAt > now) {
    return {success: true, highestUsage: cached.highestUsage, p90Usage: cached.p90Usage}
  }

  const startDate = getHighestUsagePeriod(interval)
  const endDate = new Date()
  const usageRows = await getTokenUseQueryService().getTimelineRowsAllJobs({startDate, endDate})
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

  timelineAllJobsStatsCache.set(cacheKey, {highestUsage, p90Usage, expiresAt: now + timelineAllJobsStatsTTLms})

  return {success: true, highestUsage, p90Usage}
}

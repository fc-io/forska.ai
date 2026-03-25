import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'
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

  const startDate = getHighestUsagePeriod(interval)
  const endDate = new Date()
  const usageRows = await getTokenUseQueryService().getTimelineRowsForProject({projectId, startDate, endDate})

  if (usageRows.length === 0) {
    return {success: true, highestUsage: null, p90Usage: null}
  }
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

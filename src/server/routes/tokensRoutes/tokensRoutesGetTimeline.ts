import {and, desc, eq, gte, lt, sql, sum} from 'drizzle-orm'

import {judgmentsJobs, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type TimelineParams = {
  projectId: string
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

export const tokensRoutesGetTimeline = async ({projectId, interval, startDate, endDate}: TimelineParams) => {
  const db = getDatabase()

  // Use fixed-second binning for non-month intervals
  const isMonthly = interval === '1m'
  const intervalSeconds = isMonthly ? undefined : getIntervalSeconds(interval as Exclude<typeof interval, '1m'>)

  // Get all job IDs for this project
  const projectJobs = await db
    .select({id: judgmentsJobs.id})
    .from(judgmentsJobs)
    .where(eq(judgmentsJobs.projectId, projectId))

  const jobIds = projectJobs.map((job) => {
    return job.id
  })

  if (jobIds.length === 0) {
    return {success: true, data: []}
  }

  // Build time bucket expression
  const timeBucket = isMonthly
    ? sql`date_trunc('month', ${tokenUse.createdAt})`
    : sql`date_bin(
    interval '${sql.raw((intervalSeconds as number).toString())} seconds',
    ${tokenUse.createdAt},
    timestamptz '${sql.raw(startDate)}'
  )`

  const result = await db
    .select({
      timeBucket: timeBucket,
      totalPromptTokens: sum(tokenUse.totalPromptTokens),
      totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
      totalTokens: sum(tokenUse.totalTokens),
      count: sql<number>`count(*)::int`,
    })
    .from(tokenUse)
    .where(
      and(
        sql`${tokenUse.judgmentsJobId} = ANY(ARRAY[${sql.join(jobIds, sql`, `)}]::uuid[])`,
        gte(tokenUse.createdAt, new Date(startDate)),
        // end-exclusive boundary; if endDate is now, the current bucket is included
        lt(tokenUse.createdAt, new Date(endDate)),
      ),
    )
    .groupBy(timeBucket)
    .orderBy(desc(timeBucket))

  // Transform the result to include all time buckets, even empty ones
  const startTime = new Date(startDate)
  const endTime = new Date(endDate)

  const allBuckets: Date[] = []
  if (isMonthly) {
    // Align to first-of-month boundaries and include current month (progress-to-date)
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

  // Create a map of existing data
  const dataMap = new Map(
    result.map((row) => {
      return [
        new Date(row.timeBucket as string).getTime(),
        {
          timestamp: row.timeBucket as string,
          totalPromptTokens: Number(row.totalPromptTokens || 0),
          totalCompletionTokens: Number(row.totalCompletionTokens || 0),
          totalTokens: Number(row.totalTokens || 0),
          count: row.count,
        },
      ]
    }),
  )

  // Fill in missing buckets with zeros
  const completeData = allBuckets.map((bucket) => {
    const existing = dataMap.get(bucket.getTime())
    return (
      existing || {
        timestamp: bucket.toISOString(),
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        count: 0,
      }
    )
  })

  return {success: true, data: completeData}
}

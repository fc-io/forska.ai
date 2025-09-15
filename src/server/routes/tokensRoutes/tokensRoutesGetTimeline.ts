import {and, desc, eq, gte, lte, sql, sum} from 'drizzle-orm'

import {judgmentsJobs, tokenUse} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

type TimelineParams = {
  projectId: string
  interval: '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'
  startDate: string
  endDate: string
}

const getIntervalSeconds = (interval: TimelineParams['interval']): number => {
  const intervals = {
    '1min': 60,
    '5min': 5 * 60,
    '15min': 15 * 60,
    '1h': 60 * 60,
    '24h': 24 * 60 * 60,
    '1w': 7 * 24 * 60 * 60,
    '1m': 30 * 24 * 60 * 60,
  }
  return intervals[interval]
}

export const tokensRoutesGetTimeline = async ({projectId, interval, startDate, endDate}: TimelineParams) => {
  const db = getDatabase()

  const intervalSeconds = getIntervalSeconds(interval)

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

  // Build time bucket query using raw SQL for PostgreSQL date_bin function
  const timeBucket = sql`date_bin(
    interval '${sql.raw(intervalSeconds.toString())} seconds',
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
        lte(tokenUse.createdAt, new Date(endDate)),
      ),
    )
    .groupBy(timeBucket)
    .orderBy(desc(timeBucket))

  // Transform the result to include all time buckets, even empty ones
  const startTime = new Date(startDate).getTime()
  const endTime = new Date(endDate).getTime()
  const intervalMs = intervalSeconds * 1000

  const allBuckets = []
  for (let time = startTime; time <= endTime; time += intervalMs) {
    allBuckets.push(new Date(time))
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

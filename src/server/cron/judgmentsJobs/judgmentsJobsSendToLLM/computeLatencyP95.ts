import {and, desc, eq, isNotNull} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'

const percentileCompute = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => {
    return a - b
  })
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

const percentile = (values: number[], p: number): number => {
  const isEmpty = values.length === 0
  return isEmpty ? 0 : percentileCompute(values, p)
}

export const computeLatencyP95 = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<{p95Ms: number | null; sampleSize: number}> => {
  const rows = await db
    .select({sentAt: schema.judgmentsJobsArticles.sentAt, judgedAt: schema.judgmentsJobsArticles.judgedAt})
    .from(schema.judgmentsJobsArticles)
    .where(
      and(
        eq(schema.judgmentsJobsArticles.status, 'judged'),
        eq(schema.judgmentsJobsArticles.serverId, serverJobId),
        isNotNull(schema.judgmentsJobsArticles.sentAt),
        isNotNull(schema.judgmentsJobsArticles.judgedAt),
      ),
    )
    .orderBy(desc(schema.judgmentsJobsArticles.judgedAt))
    .limit(100)

  console.log('rows')
  console.log(rows)

  const durations = rows
    .map((r) => {
      const start =
        r.sentAt instanceof Date ? r.sentAt.getTime() : new Date((r.sentAt as unknown as string) ?? '').getTime()
      const end =
        r.judgedAt instanceof Date ? r.judgedAt.getTime() : new Date((r.judgedAt as unknown as string) ?? '').getTime()
      const diff = end - start
      return Number.isFinite(diff) && diff >= 0 ? diff : null
    })
    .filter((v): v is number => {
      return v !== null && Number.isFinite(v)
    })

  const sampleSize = durations.length
  console.log('durations', durations)

  const insufficient = sampleSize < 5
  console.log('insufficient', insufficient)
  return insufficient ? {p95Ms: null, sampleSize} : {p95Ms: percentile(durations, 95), sampleSize}
}

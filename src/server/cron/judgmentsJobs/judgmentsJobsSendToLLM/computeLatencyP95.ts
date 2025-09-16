import {and, desc, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {status} from 'elysia'

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
    .select({
      createdAt: schema.judgmentsJobsArticles.createdAt,
      updatedAt: schema.judgmentsJobsArticles.updatedAt,
      status: schema.judgmentsJobsArticles.status,
    })
    .from(schema.judgmentsJobsArticles)
    .where(and(eq(schema.judgmentsJobsArticles.status, 'sent'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)))
    .orderBy(desc(schema.judgmentsJobsArticles.updatedAt))
    .limit(100)
  console.log('rows')
  console.log(rows)
  const durations = rows
    .map((r) => {
      const start =
        r.createdAt instanceof Date
          ? r.createdAt.getTime()
          : new Date((r.createdAt as unknown as string) ?? '').getTime()
      const end =
        r.updatedAt instanceof Date
          ? r.updatedAt.getTime()
          : new Date((r.updatedAt as unknown as string) ?? '').getTime()
      const diff = end - start
      return Number.isFinite(diff) && diff >= 0 ? diff : null
    })
    .filter((v): v is number => {
      return v !== null && Number.isFinite(v)
    })

  const sampleSize = durations.length

  const insufficient = sampleSize < 5
  return insufficient ? computeInsufficientSample(sampleSize) : computeFromDurations(durations, sampleSize)
}

const computeInsufficientSample = (n: number): {p95Ms: number | null; sampleSize: number} => {
  return {p95Ms: null, sampleSize: n}
}

const computeFromDurations = (values: number[], n: number): {p95Ms: number | null; sampleSize: number} => {
  return {p95Ms: percentile(values, 95), sampleSize: n}
}

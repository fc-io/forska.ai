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
): Promise<{p95Ms: number | null; sampleSize: number}> => {
  const rows = await db
    .select({duration: schema.tokenUse.duration})
    .from(schema.tokenUse)
    .where(and(eq(schema.tokenUse.requests, 1), isNotNull(schema.tokenUse.judgmentsJobId)))
    .orderBy(desc(schema.tokenUse.createdAt))
    .limit(100)

  const durations = rows
    .map((r) => {
      return typeof r.duration === 'number' ? r.duration : null
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

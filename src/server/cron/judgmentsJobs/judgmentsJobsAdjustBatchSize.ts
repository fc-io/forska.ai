import {eq, gte, or} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await db
    .select({
      id: schema.judgmentsJobs.id,
      sendToLLMBatchSize: schema.judgmentsJobs.sendToLLMBatchSize,
      sendToLLMInterval: schema.judgmentsJobs.sendToLLMInterval,
    })
    .from(schema.judgmentsJobs)
  const vllmMetricsUrl = env.VITE_LLM_SERVER_URL + '/metrics'
}

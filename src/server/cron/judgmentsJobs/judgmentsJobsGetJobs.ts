import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const judgmentsJobsGetJobs = async (db: PostgresJsDatabase<typeof schema>) => {
  return await db
    .select({
      id: schema.judgmentsJobs.id,
      status: schema.judgmentsJobs.status,
      projectId: schema.judgmentsJobs.projectId,
      projectName: schema.projects.name,
      sendToLLMBatchSize: schema.judgmentsJobs.sendToLLMBatchSize,
      sendToLLMInterval: schema.judgmentsJobs.sendToLLMInterval,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
}

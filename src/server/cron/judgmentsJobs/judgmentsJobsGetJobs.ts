import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import type {JobData} from './judgmentsJobsTypes.ts'

export const judgmentsJobsGetJobs = async (db: PostgresJsDatabase<typeof schema>): Promise<JobData[]> => {
  return await db
    .select({
      jobId: schema.judgmentsJobs.id,
      jobStatus: schema.judgmentsJobs.status,
      projectId: schema.judgmentsJobs.projectId,
      projectName: schema.projects.name,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
}

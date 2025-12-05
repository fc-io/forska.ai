import {eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const judgmentsJobsGetRunningJobs = (db: PostgresJsDatabase<typeof schema>) => {
  return db
    .select({id: schema.judgmentsJobs.id, projectId: schema.judgmentsJobs.projectId})
    .from(schema.judgmentsJobs)
    .where(eq(schema.judgmentsJobs.status, 'running'))
}

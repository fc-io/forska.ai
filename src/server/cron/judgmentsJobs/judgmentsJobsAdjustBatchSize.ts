import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  console.log('judgmentsJobsAdjustBatchSize', judgmentsJobsAdjustBatchSize)
}

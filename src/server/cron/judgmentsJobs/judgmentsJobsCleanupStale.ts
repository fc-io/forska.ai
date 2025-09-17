import {lt} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const judgmentsJobsCleanupStale = async (db: PostgresJsDatabase<typeof schema>): Promise<void> => {
  const fifteenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)

  await db.delete(schema.judgmentsJobsArticles).where(lt(schema.judgmentsJobsArticles.updatedAt, fifteenMinutesAgo))
}

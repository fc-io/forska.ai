import {and, count, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

export const getNumberOfArticlesInReadyQueue = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  jobId?: string,
): Promise<number> => {
  const whereClause = and(
    eq(schema.judgmentsJobsArticles.status, 'ready'),
    eq(schema.judgmentsJobsArticles.serverId, serverJobId),
    jobId ? eq(schema.judgmentsJobsArticles.jobId, jobId) : undefined,
  )

  const result = await db.select({count: count()}).from(schema.judgmentsJobsArticles).where(whereClause)

  return result[0]?.count || 0
}

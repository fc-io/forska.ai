import {and, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'

export const getBacklogSentCount = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<number> => {
  const rows = await db
    .select({id: schema.judgmentsJobsArticles.id})
    .from(schema.judgmentsJobsArticles)
    .where(and(eq(schema.judgmentsJobsArticles.status, 'sent'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)))

  return rows.length
}
